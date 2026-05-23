import { randomUUID } from 'crypto';
import { db } from '../db-storage';
import getReproMetadata from '../lib/repro';

type RetrainTicket = {
  id: string;
  traceId?: string | null;
  reason: string;
  snapshot?: any;
  autoShadow: boolean;
  status: 'open' | 'in-progress' | 'validated' | 'needs_review' | 'canary' | 'closed';
  createdAt: string;
  events: any[];
};

class RetrainManager {
  private tickets: Map<string, RetrainTicket> = new Map();

  listTickets(): RetrainTicket[] {
    return Array.from(this.tickets.values()).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async createTicket(opts: { traceId?: string | null; reason: string; snapshot?: any; autoShadow?: boolean; createdBy?: string }) {
    const id = randomUUID();
    const ticket: RetrainTicket = {
      id,
      traceId: opts.traceId ?? null,
      reason: opts.reason,
      snapshot: opts.snapshot ?? null,
      autoShadow: !!opts.autoShadow,
      status: 'open',
      createdAt: new Date().toISOString(),
      events: []
    };
    this.tickets.set(id, ticket);

    const meta = getReproMetadata();

    try {
      if (ticket.snapshot) {
        await db.createDecisionSnapshot?.({
          traceId: ticket.traceId ?? undefined,
          timestamp: new Date(),
          agents: [],
          contributions: {},
          policyOutputs: {},
          positionSizing: {},
          marketFrameId: ticket.snapshot?.marketFrameId ?? null,
          worldTime: ticket.snapshot?.worldTime ?? new Date(),
          moduleVersion: meta.moduleVersion,
          extra: { reason: ticket.reason, createdBy: opts.createdBy ?? 'system', commitSha: meta.commitSha, snapshot: ticket.snapshot }
        });
      }
    } catch (e) {
      // non-fatal
    }

    // Emit a DecisionEvent representing the ticket
    try {
      await db.createDecisionEvent?.({
        correlationId: ticket.traceId ?? null,
        phase: 'RETRAIN',
        domain: 'Model',
        actionPayload: { action: 'create_retrain_ticket', ticketId: id, reason: ticket.reason },
        metrics: { autoShadow: ticket.autoShadow ? 1 : 0 },
        moduleVersion: meta.moduleVersion,
        marketFrameId: ticket.snapshot?.marketFrameId ?? null,
        timestamp: new Date(),
        extra: { commitSha: meta.commitSha, createdBy: opts.createdBy ?? 'system' }
      });
    } catch (e) {}

    // Optionally start an automatic shadow retrain
    if (ticket.autoShadow || process.env.AUTO_SHADOW_RETRAIN === 'true') {
      // do not await
      void this.shadowRetrain(id).catch((err) => {
        console.warn('[RetrainManager] shadow retrain failed', err);
      });
    }

    return ticket;
  }

  async shadowRetrain(ticketId: string) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error('ticket not found');
    if (ticket.status === 'in-progress') return ticket;
    ticket.status = 'in-progress';
    ticket.events.push({ type: 'shadow_retrain.started', ts: new Date().toISOString() });

    const meta = getReproMetadata();
    try {
      await db.createDecisionEvent?.({ correlationId: ticket.traceId ?? null, phase: 'RETRAIN', domain: 'Model', actionPayload: { action: 'shadow_retrain_started', ticketId }, metrics: {}, moduleVersion: meta.moduleVersion, timestamp: new Date(), extra: { commitSha: meta.commitSha } });
    } catch (e) {}

    // If a real retrain command is configured, try to execute it; otherwise simulate
    let metrics: any = {};
    const cmd = process.env.SHADOW_RETRAIN_COMMAND;
    if (cmd) {
      // try to run configured command (non-blocking simple exec)
      try {
        const { exec } = await import('child_process');
        const promise = new Promise<string>((resolve, reject) => {
          exec(cmd, { cwd: process.cwd(), env: process.env }, (err, stdout, _stderr) => {
            if (err) return reject(err);
            resolve(stdout || '');
          });
        });
        const out = await promise;
        metrics = { output: out.substring(0, 4000) };
      } catch (e: any) {
        metrics = { error: String(e?.message ?? e) };
      }
    } else {
      // Simulate retrain (quick placeholder)
      await new Promise((r) => setTimeout(r, 1500));
      const valAcc = Math.round((0.5 + Math.random() * 0.25) * 1000) / 1000; // e.g. 0.5-0.75
      metrics = { validationAccuracy: valAcc, simulated: true };
    }

    ticket.events.push({ type: 'shadow_retrain.completed', metrics, ts: new Date().toISOString() });
    try {
      await db.createDecisionEvent?.({ correlationId: ticket.traceId ?? null, phase: 'RETRAIN', domain: 'Model', actionPayload: { action: 'shadow_retrain_completed', ticketId }, metrics, moduleVersion: meta.moduleVersion, timestamp: new Date(), extra: { commitSha: meta.commitSha } });
    } catch (e) {}

    // simple validation
    try {
      await this.validateShadowResults(ticketId, metrics);
    } catch (e) {
      console.warn('[RetrainManager] validateShadowResults error', e);
    }

    return ticket;
  }

  async validateShadowResults(ticketId: string, metrics: any) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error('ticket not found');
    const meta = getReproMetadata();
    const acc = metrics?.validationAccuracy ?? metrics?.accuracy ?? null;
    const pass = typeof acc === 'number' ? acc >= (parseFloat(process.env.RETRAIN_VALIDATE_THRESHOLD ?? '0.55')) : false;
    ticket.status = pass ? 'validated' : 'needs_review';
    ticket.events.push({ type: 'validation.result', ok: pass, metrics, ts: new Date().toISOString() });
    await db.createDecisionEvent?.({ correlationId: ticket.traceId ?? null, phase: 'RETRAIN', domain: 'Model', actionPayload: { action: 'validation_result', ticketId, ok: pass }, metrics: metrics ?? {}, moduleVersion: meta.moduleVersion, timestamp: new Date(), extra: { commitSha: meta.commitSha } });

    if (pass && (process.env.AUTO_CANARY_DEPLOY === 'true' || ticket.autoShadow && process.env.AUTO_CANARY_DEPLOY === 'true')) {
      try { await this.canaryDeploy(ticketId); } catch (e) { console.warn('[RetrainManager] canary deploy failed', e); }
    }

    return pass;
  }

  async canaryDeploy(ticketId: string) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error('ticket not found');
    ticket.status = 'canary';
    const meta = getReproMetadata();
    await db.createDecisionEvent?.({ correlationId: ticket.traceId ?? null, phase: 'RETRAIN', domain: 'Model', actionPayload: { action: 'canary_deploy_started', ticketId }, metrics: {}, moduleVersion: meta.moduleVersion, timestamp: new Date(), extra: { commitSha: meta.commitSha } });

    // simulated canary: wait then mark closed
    await new Promise((r) => setTimeout(r, 2000));
    ticket.status = 'closed';
    ticket.events.push({ type: 'canary_deploy.completed', ts: new Date().toISOString() });
    await db.createDecisionEvent?.({ correlationId: ticket.traceId ?? null, phase: 'RETRAIN', domain: 'Model', actionPayload: { action: 'canary_deploy_completed', ticketId }, metrics: {}, moduleVersion: meta.moduleVersion, timestamp: new Date(), extra: { commitSha: meta.commitSha } });
    return ticket;
  }

  async approveTicket(ticketId: string) {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) throw new Error('ticket not found');
    ticket.status = 'validated';
    // trigger canary deploy if configured
    if (process.env.AUTO_CANARY_DEPLOY === 'true') await this.canaryDeploy(ticketId);
    return ticket;
  }

  async triggerShadow(ticketId: string) {
    return this.shadowRetrain(ticketId);
  }
}

export const retrainManager = new RetrainManager();
export default retrainManager;
