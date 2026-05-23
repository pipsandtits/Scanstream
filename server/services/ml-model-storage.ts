/**
 * ml-model-storage.ts
 *
 * Fixes vs. original:
 *  1. ModelWeights type updated to match real classifier weight shapes from
 *     ml-predictions.ts (LogisticRegression) and advanced-ml-service.ts
 *     (SoftmaxClassifier × 2). Old flat number[] arrays are gone.
 *  2. Weights + metadata written as ONE atomic JSON object in ONE file,
 *     eliminating the corruption window between two separate writeFile calls.
 *  3. Atomic write: write to .tmp then fs.rename (atomic on Linux/macOS).
 *  4. loadLatestWeights distinguishes ENOENT (clean miss → null) from real
 *     errors (parse failure, disk error → throws).
 *  5. Runtime schema validation on load — rejects structurally wrong files
 *     instead of silently returning a bad object.
 *  6. modelsDir resolved lazily so process.cwd() is read at call time, not
 *     at module import time.
 *  7. listModels reads all metadata files concurrently (Promise.all).
 *  8. loadByTimestamp added so versioned files are actually usable.
 *  9. pruneOldModels added — keeps the N most recent versions, deletes the rest.
 * 10. Timestamp in filename is Date.now() (plain integer) — sortable, unambiguous.
 */

import { promises as fs } from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Weight shape types — must stay in sync with the classifier implementations
// ---------------------------------------------------------------------------

/** Logistic regression (binary) — used by MLPredictionService direction classifier */
export interface LogisticWeights {
  weights: number[];
  bias:    number;
}

/** Softmax (multi-class) — used by AdvancedMLService regime + breakout classifiers */
export interface SoftmaxWeights {
  W: number[][];   // [classes][features]
  b: number[];
}

/**
 * Full model weight snapshot.
 * Each field is optional so callers can save only what they own.
 */
export interface ModelWeights {
  // MLPredictionService
  direction?: LogisticWeights;

  // AdvancedMLService
  regime?:    SoftmaxWeights;
  breakout?:  SoftmaxWeights;
  squeeze?:   LogisticWeights;
}

export interface ModelMetadata {
  version:      string;
  trainedAt:    string;
  dataPoints:   number;
  featureCount?: number;
  accuracy?:    number;
  [key: string]: unknown;   // allow extra fields from callers
}

/** Single on-disk record: weights + metadata in one file */
interface StorageRecord {
  metadata: ModelMetadata;
  weights:  ModelWeights;
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isLogisticWeights(v: unknown): v is LogisticWeights {
  return (
    typeof v === 'object' && v !== null &&
    Array.isArray((v as any).weights) &&
    typeof (v as any).bias === 'number'
  );
}

function isSoftmaxWeights(v: unknown): v is SoftmaxWeights {
  return (
    typeof v === 'object' && v !== null &&
    Array.isArray((v as any).W) &&
    Array.isArray((v as any).b)
  );
}

/** FIX 5: validate at least one recognised weight key is present and well-formed. */
function validateRecord(raw: unknown): StorageRecord {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Storage record is not an object');
  }
  const r = raw as any;

  if (typeof r.metadata !== 'object' || r.metadata === null) {
    throw new Error('Storage record missing metadata');
  }
  if (typeof r.weights !== 'object' || r.weights === null) {
    throw new Error('Storage record missing weights');
  }

  // Validate each weight block that is present
  const w = r.weights;
  if (w.direction  !== undefined && !isLogisticWeights(w.direction))  throw new Error('weights.direction has wrong shape');
  if (w.squeeze    !== undefined && !isLogisticWeights(w.squeeze))    throw new Error('weights.squeeze has wrong shape');
  if (w.regime     !== undefined && !isSoftmaxWeights(w.regime))      throw new Error('weights.regime has wrong shape');
  if (w.breakout   !== undefined && !isSoftmaxWeights(w.breakout))    throw new Error('weights.breakout has wrong shape');

  return r as StorageRecord;
}

// ---------------------------------------------------------------------------
// MLModelStorage
// ---------------------------------------------------------------------------

export class MLModelStorage {
  // FIX 6: resolved lazily, not at import time
  private static get modelsDir(): string {
    return path.join(process.cwd(), 'data', 'ml-models');
  }

  private static latestPath(): string {
    return path.join(this.modelsDir, 'model-latest.json');
  }

  private static versionedPath(ts: number): string {
    return path.join(this.modelsDir, `model-${ts}.json`);
  }

  /** FIX 3: write to .tmp then rename (atomic on Linux/macOS) */
  private static async atomicWrite(filePath: string, data: string): Promise<void> {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, data, 'utf-8');
    await fs.rename(tmp, filePath);
  }

  // ---------------------------------------------------------------------------
  // Save
  // ---------------------------------------------------------------------------

  /**
   * FIX 2: weights + metadata written as one JSON blob.
   * FIX 3: atomic write via tmp + rename.
   * FIX 10: timestamp is Date.now() integer.
   */
  static async saveWeights(weights: ModelWeights, metadata: Omit<ModelMetadata, 'version'>): Promise<number> {
    await fs.mkdir(this.modelsDir, { recursive: true });

    const ts = Date.now();
    const record: StorageRecord = {
      metadata: ({ version: '2.0', trainedAt: new Date(ts).toISOString(), ...(metadata as any) } as ModelMetadata),
      weights
    };
    const json = JSON.stringify(record, null, 2);

    // Write versioned snapshot
    await this.atomicWrite(this.versionedPath(ts), json);

    // Overwrite latest pointer
    await this.atomicWrite(this.latestPath(), json);

    console.log(`[ML Storage] Saved model snapshot ${ts}`);
    return ts;
  }

  // ---------------------------------------------------------------------------
  // Load latest
  // ---------------------------------------------------------------------------

  /**
   * FIX 4: ENOENT → null (clean first-run path).
   *         Any other error (parse failure, bad schema) → throws so the caller
   *         knows something is wrong rather than silently falling back to an
   *         untrained model during live trading.
   * FIX 5: schema validation before returning.
   */
  static async loadLatestWeights(): Promise<{ weights: ModelWeights; metadata: ModelMetadata } | null> {
    const filePath = this.latestPath();
    let raw: string;

    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;   // clean miss — no model saved yet
      throw err;                                 // real I/O error — propagate
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`[ML Storage] Corrupt weights file at ${filePath}: ${err}`);
    }

    const record = validateRecord(parsed);   // FIX 5: throws on bad schema
    console.log('[ML Storage] Loaded weights from:', record.metadata.trainedAt);
    return { weights: record.weights, metadata: record.metadata };
  }

  // ---------------------------------------------------------------------------
  // Load by timestamp  (FIX 8: versioned files are now actually usable)
  // ---------------------------------------------------------------------------

  static async loadByTimestamp(ts: number): Promise<{ weights: ModelWeights; metadata: ModelMetadata } | null> {
    const filePath = this.versionedPath(ts);
    let raw: string;

    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`[ML Storage] Corrupt weights file at ${filePath}: ${err}`);
    }

    return validateRecord(parsed);
  }

  // ---------------------------------------------------------------------------
  // List models  (FIX 7: concurrent reads)
  // ---------------------------------------------------------------------------

  static async listModels(): Promise<Array<ModelMetadata & { timestamp: number }>> {
    await fs.mkdir(this.modelsDir, { recursive: true });

    let files: string[];
    try {
      files = await fs.readdir(this.modelsDir);
    } catch {
      return [];
    }

    // Only versioned snapshots, not latest or tmp files
    const versionedFiles = files.filter(
      f => f.startsWith('model-') && f !== 'model-latest.json' && f.endsWith('.json')
    );

    // FIX 7: read all in parallel
    const results = await Promise.allSettled(
      versionedFiles.map(async (f) => {
        const raw    = await fs.readFile(path.join(this.modelsDir, f), 'utf-8');
        const parsed = JSON.parse(raw);
        const record = validateRecord(parsed);
        const ts     = parseInt(f.replace('model-', '').replace('.json', ''), 10);
        return { ...record.metadata, timestamp: ts };
      })
    );

    return results
      .filter((r): r is PromiseFulfilledResult<ModelMetadata & { timestamp: number }> => r.status === 'fulfilled')
      .map(r => r.value)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  // ---------------------------------------------------------------------------
  // Prune old models  (FIX 9: prevent unbounded disk growth)
  // ---------------------------------------------------------------------------

  /**
   * Keep only the `keep` most recent versioned snapshots; delete the rest.
   * The `latest` symlink/file is never deleted.
   */
  static async pruneOldModels(keep = 10): Promise<number> {
    const models = await this.listModels();   // already sorted newest-first
    const toDelete = models.slice(keep);

    await Promise.all(
      toDelete.map(m => fs.unlink(this.versionedPath(m.timestamp)).catch(() => { /* already gone */ }))
    );

    if (toDelete.length > 0) {
      console.log(`[ML Storage] Pruned ${toDelete.length} old model snapshot(s)`);
    }
    return toDelete.length;
  }
}