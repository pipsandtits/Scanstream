import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export function getReproMetadata() {
  let commitSha: string | null = process.env.COMMIT_SHA ?? null;
  if (!commitSha) {
    try {
      commitSha = (execSync('git rev-parse --short HEAD', { cwd: process.cwd(), encoding: 'utf8' }) || '').trim() || null;
    } catch (e) {
      commitSha = null;
    }
  }

  let moduleVersion: string | null = null;
  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      moduleVersion = pkg.version || null;
    }
  } catch (e) {
    moduleVersion = process.env.npm_package_version ?? null;
  }

  return {
    commitSha,
    moduleVersion,
    nodeEnv: process.env.NODE_ENV ?? 'development'
  } as const;
}

export default getReproMetadata;
