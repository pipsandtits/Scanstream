import { randomUUID } from 'crypto';

export function generateTraceId(): string {
  return typeof randomUUID === 'function' ? randomUUID() : `trace-${Date.now()}`;
}

export function currentReproMetadata(): Record<string, any> {
  return {
    commitSha: process.env.COMMIT_SHA || null,
    modelVersion: process.env.MODEL_VERSION || null,
    nodeEnv: process.env.NODE_ENV || null,
    host: process.env.HOSTNAME || null,
    capturedAt: new Date().toISOString(),
  };
}
