import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

const META_VERSION = 1;

export function artifactMetadataPath(root, artifactPath) {
  const rel = relative(root, artifactPath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const key = createHash('sha256').update(rel).digest('hex').slice(0, 24);
  return join(root, '.xitto-kernel', 'artifacts', `${key}.json`);
}

export function writeArtifactMetadata(root, artifactPath, metadata = {}) {
  const metaPath = artifactMetadataPath(root, artifactPath);
  if (!metaPath) return false;
  const rel = relative(root, artifactPath);
  const stat = statSync(artifactPath);
  const body = {
    version: META_VERSION,
    path: rel,
    name: basename(artifactPath),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    updatedAt: new Date().toISOString(),
    ...metadata,
  };
  mkdirSync(dirname(metaPath), { recursive: true });
  writeFileSync(metaPath, JSON.stringify(body, null, 2));
  return true;
}

export function readArtifactMetadata(root, artifactPath) {
  const metaPath = artifactMetadataPath(root, artifactPath);
  if (!metaPath || !existsSync(metaPath)) return null;
  try {
    const data = JSON.parse(readFileSync(metaPath, 'utf8'));
    if (data?.version !== META_VERSION) return null;
    if (data?.path !== relative(root, artifactPath)) return null;
    const stat = statSync(artifactPath);
    if (data?.size !== stat.size || data?.mtimeMs !== stat.mtimeMs) return null;
    return data;
  } catch {
    return null;
  }
}
