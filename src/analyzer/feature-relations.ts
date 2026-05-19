import * as path from 'path';
import { FileInfo, DataFlowFeature, FeatureRelation } from './types';
import { AIRawOutputRelation } from '../ai/types';

const EXTENSIONS = ['.ts', '.tsx', '.vue', '.js'];

/**
 * Derive inter-feature dependency edges from two sources:
 * 1. Static: trace local imports that cross feature boundaries
 * 2. AI: semantic labels returned by the model (higher-quality descriptions)
 * Both are merged; AI label takes precedence when the same edge exists in both.
 */
export function inferFeatureRelations(
  files: FileInfo[],
  dataFlow: DataFlowFeature[],
  aiRelations: AIRawOutputRelation[]
): FeatureRelation[] {
  const fileToFeature = buildFileFeatureIndex(files, dataFlow);
  const fileSet = new Set(files.map((f) => norm(f.relativePath)));

  // Collect static edges (one representative per from→to pair)
  const staticEdges = new Map<string, FeatureRelation>();

  for (const file of files) {
    const srcFeature = fileToFeature.get(norm(file.relativePath));
    if (!srcFeature) continue;

    for (const imp of file.imports) {
      if (imp.kind !== 'local') continue;
      const resolved = resolveLocalImport(file.relativePath, imp.source, fileSet);
      if (!resolved) continue;

      const tgtFeature = fileToFeature.get(resolved);
      if (!tgtFeature || tgtFeature === srcFeature) continue;

      const key = `${srcFeature}\0${tgtFeature}`;
      if (!staticEdges.has(key)) {
        staticEdges.set(key, {
          from: srcFeature,
          to: tgtFeature,
          label: `${path.basename(file.relativePath)} → ${path.basename(resolved)}`,
          source: 'static',
        });
      }
    }
  }

  // Merge: AI edges replace static labels for the same from→to pair
  const result: FeatureRelation[] = [];

  for (const ai of aiRelations) {
    if (!ai.from || !ai.to || ai.from === ai.to) continue;
    const key = `${ai.from}\0${ai.to}`;
    result.push({
      from: ai.from,
      to: ai.to,
      label: ai.label || '',
      source: staticEdges.has(key) ? 'merged' : 'ai',
    });
    staticEdges.delete(key);
  }

  for (const edge of staticEdges.values()) {
    result.push(edge);
  }

  return result;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function buildFileFeatureIndex(
  files: FileInfo[],
  dataFlow: DataFlowFeature[]
): Map<string, string> {
  // Build two lookup tables over actual file paths
  const normToPath = new Map<string, string>();  // normalized → normalized (canonical)
  const baseToNorms = new Map<string, string[]>(); // basename-no-ext → normalized paths

  for (const f of files) {
    const n = norm(f.relativePath);
    normToPath.set(n, n);
    const b = baseNoExt(n);
    const list = baseToNorms.get(b) ?? [];
    list.push(n);
    baseToNorms.set(b, list);
  }

  const index = new Map<string, string>(); // normalized filePath → featureName

  for (const feature of dataFlow) {
    for (const comp of feature.components) {
      if (!comp.name) continue;
      const compNorm = norm(comp.name);

      // 1. Exact match
      if (normToPath.has(compNorm)) {
        index.set(compNorm, feature.feature);
        continue;
      }

      // 2. Try appending common extensions
      let matched = false;
      for (const ext of EXTENSIONS) {
        const candidate = compNorm.endsWith(ext) ? compNorm : compNorm + ext;
        if (normToPath.has(candidate)) {
          index.set(candidate, feature.feature);
          matched = true;
          break;
        }
      }
      if (matched) continue;

      // 3. Basename fuzzy match (only if unambiguous)
      const base = baseNoExt(compNorm);
      const candidates = baseToNorms.get(base);
      if (candidates?.length === 1) {
        index.set(candidates[0], feature.feature);
      }
    }
  }

  return index;
}

function resolveLocalImport(
  fileRelPath: string,
  source: string,
  fileSet: Set<string>
): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null;

  const fileDir = norm(path.dirname(fileRelPath));
  const joined = path.posix
    .normalize(path.posix.join(fileDir === '.' ? '' : fileDir, source))
    .replace(/^\.\//, '');

  if (fileSet.has(joined)) return joined;

  for (const ext of EXTENSIONS) {
    if (fileSet.has(joined + ext)) return joined + ext;
  }
  for (const ext of EXTENSIONS) {
    const idx = joined + '/index' + ext;
    if (fileSet.has(idx)) return idx;
  }

  return null;
}

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function baseNoExt(p: string): string {
  const base = path.posix.basename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
