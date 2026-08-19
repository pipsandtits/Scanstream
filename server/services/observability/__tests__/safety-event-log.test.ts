import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SafetyEventLog } from '../safety-event-log';

describe('durable safety event log', () => {
  let dir: string;
  let file: string;
  let log: SafetyEventLog;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safety-log-'));
    file = path.join(dir, 'nested', 'safety-events.jsonl');
    log = new SafetyEventLog();
    log.setFilePath(file);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('persists safety events to disk, creating the directory', () => {
    log.record({ type: 'execution_blocked', detail: 'durable_state_unavailable' });

    expect(fs.existsSync(file)).toBe(true);
    expect(log.readPersisted()).toHaveLength(1);
    expect(log.readPersisted()[0].detail).toBe('durable_state_unavailable');
  });

  it('survives a restart: a new instance reads events written by the previous one', () => {
    log.record({ type: 'kill_switch', detail: 'activated: manual' });
    log.record({ type: 'flatten_failed', detail: '2 position(s) failed to close' });

    const afterRestart = new SafetyEventLog();
    afterRestart.setFilePath(file);

    // Nothing in memory, everything still on disk.
    expect(afterRestart.tail()).toEqual([]);
    expect(afterRestart.readPersisted().map((e) => e.type)).toEqual(['kill_switch', 'flatten_failed']);
  });

  it('appends rather than overwriting', () => {
    for (let i = 0; i < 5; i += 1) log.record({ type: 'candle_rejected', detail: `batch-${i}` });
    expect(log.readPersisted()).toHaveLength(5);
  });

  it('skips a truncated final line left by a crash mid-append', () => {
    log.record({ type: 'execution_blocked', detail: 'first' });
    fs.appendFileSync(file, '{"type":"execution_bl');

    const events = log.readPersisted();
    expect(events).toHaveLength(1);
    expect(events[0].detail).toBe('first');
  });

  it('records operator actions with before/after state and never the token', () => {
    log.recordOperatorAction({
      action: 'stop',
      target: 'engine',
      previousState: { isRunning: true },
      resultingState: { isRunning: false },
      success: true,
      reason: 'venue degraded',
      requestId: 'req-1',
    });

    const [event] = log.readPersisted() as any[];
    expect(event).toMatchObject({
      type: 'operator_action',
      action: 'stop',
      operator: 'shared-operator-token',
      success: true,
      reason: 'venue degraded',
      requestId: 'req-1',
      previousState: { isRunning: true },
      resultingState: { isRunning: false },
    });
    expect(JSON.stringify(event)).not.toMatch(/token["']?\s*:\s*["'][^"']/i);
  });

  it('records failed operator actions, not just successful ones', () => {
    log.recordOperatorAction({ action: 'start', success: false, reason: 'reconciliation incomplete' });
    expect((log.readPersisted()[0] as any).success).toBe(false);
  });

  it('counts write failures instead of throwing into the trading path', () => {
    log.setFilePath(path.join(dir, 'a-file'));
    fs.writeFileSync(path.join(dir, 'a-file'), '');
    // Make the parent a file so directory creation and appends fail.
    log.setFilePath(path.join(dir, 'a-file', 'nested.jsonl'));

    expect(() => log.record({ type: 'execution_blocked', detail: 'x' })).not.toThrow();
    expect(log.getWriteFailures()).toBe(1);
    // The event is still visible in-process even when the disk write failed.
    expect(log.tail()).toHaveLength(1);
  });

  it('caps the in-memory tail while keeping everything on disk', () => {
    for (let i = 0; i < 520; i += 1) log.record({ type: 'execution_blocked', detail: `e-${i}` });

    expect(log.tail(1000)).toHaveLength(500);
    expect(log.readPersisted(1000)).toHaveLength(520);
  });
});
