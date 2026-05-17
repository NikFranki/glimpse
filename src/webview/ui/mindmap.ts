import * as fs from 'fs';
import * as path from 'path';
import { FileInfo, ModuleAnalysis } from '../../analyzer/types';

/**
 * Converts a ModuleAnalysis into markmap-flavored markdown.
 * File-linked nodes use the `glimpse-file:` scheme so the webview
 * can intercept clicks and post openFile messages back to the extension.
 */
export function buildMarkmapMarkdown(analysis: ModuleAnalysis): string {
  const moduleName = path.basename(analysis.modulePath);
  const lines: string[] = [`# ${moduleName}`];

  // ── 模块职责 ──────────────────────────────────────────────
  lines.push('', '## 模块职责');
  for (const r of analysis.ai.responsibilities) {
    lines.push(`- ${r}`);
  }

  // ── 对外暴露（按文件聚合）────────────────────────────────
  if (analysis.publicExports.length > 0) {
    lines.push('', '## 对外暴露');
    const byFile = new Map<string, typeof analysis.publicExports>();
    for (const e of analysis.publicExports) {
      const group = byFile.get(e.filePath) ?? [];
      group.push(e);
      byFile.set(e.filePath, group);
    }
    for (const [filePath, exports] of byFile) {
      const fileName = filePath.split('/').pop() ?? filePath;
      const kind = exports[0].kind;
      const encoded = encodeURIComponent(filePath);
      lines.push(`- [${fileName} *(${kind})*](glimpse-file:${encoded})`);
    }
  }

  // ── 外部依赖（四分组）──────────────────────────────────────
  const crossModuleDeps = collectCrossModuleDeps(analysis.files);
  const hasAnyDep =
    crossModuleDeps.length > 0 ||
    analysis.companyDeps.length > 0 ||
    analysis.externalDeps.length > 0 ||
    analysis.mfDeps.length > 0;

  if (hasAnyDep) {
    lines.push('', '## 外部依赖');

    if (crossModuleDeps.length > 0) {
      lines.push('', '- 项目内跨模块');
      for (const dep of crossModuleDeps) {
        const resolved = resolveAlias(dep, analysis.modulePath);
        const node = resolved
          ? `[${dep}](glimpse-mod:${encodeURIComponent(resolved)})`
          : dep;
        lines.push(`  - ${node}`);
      }
    }

    if (analysis.companyDeps.length > 0) {
      lines.push('', '- 公司共享库');
      for (const dep of analysis.companyDeps) {
        lines.push(`  - [${dep}](glimpse-pkg:${encodeURIComponent(dep)})`);
      }
    }

    if (analysis.externalDeps.length > 0) {
      lines.push('', '- npm 包');
      for (const dep of analysis.externalDeps) {
        lines.push(`  - [${dep}](glimpse-pkg:${encodeURIComponent(dep)})`);
      }
    }

    if (analysis.mfDeps.length > 0) {
      lines.push('', '- MF 跨 App');
      for (const dep of analysis.mfDeps) {
        lines.push(`  - ${dep.remote}${dep.exposedPath}`);
      }
    }
  }

  // ── 数据流 ────────────────────────────────────────────────
  if (analysis.ai.dataFlow.length > 0) {
    lines.push('', '## 数据流');
    for (const feature of analysis.ai.dataFlow) {
      lines.push(`- ${feature.feature}`);
      for (const comp of feature.components) {
        const nameLink = linkifyPaths(comp.name, analysis.modulePath);
        lines.push(`  - ${nameLink} — ${comp.usage}`);
        if (comp.deps && comp.deps.length > 0) {
          lines.push(`    - 依赖: ${comp.deps.join('、')}`);
        }
        if (comp.props && comp.props.length > 0) {
          lines.push(`    - Props: ${comp.props.join('、')}`);
        }
        if (comp.state && comp.state.length > 0) {
          lines.push(`    - State: ${comp.state.join('、')}`);
        }
        if (comp.methods && comp.methods.length > 0) {
          lines.push(`    - 方法: ${comp.methods.join('、')}`);
        }
        if (comp.jsx) {
          lines.push(`    - JSX: ${comp.jsx}`);
        }
        if (comp.behaviors && comp.behaviors.length > 0) {
          lines.push(`    - 交互逻辑`);
          for (const b of comp.behaviors) {
            lines.push(`      - ${b}`);
          }
        }
      }
    }
  }

  return lines.join('\n');
}

/** Collect unique @/ alias import roots used across all files in the module. */
function collectCrossModuleDeps(files: FileInfo[]): string[] {
  const deps = new Set<string>();
  for (const file of files) {
    for (const imp of file.imports) {
      if (imp.source.startsWith('@/') || imp.source.startsWith('~/')) {
        // '@/common/utils/foo' → '@/common'
        const parts = imp.source.split('/');
        deps.add(parts.slice(0, 2).join('/'));
      }
    }
  }
  return [...deps].sort();
}

/**
 * Resolve a webpack/tsconfig alias like `@/common` to an absolute filesystem
 * path by walking up from the module directory looking for `src/<sub>`.
 * Returns null if nothing is found on disk.
 */
function resolveAlias(dep: string, modulePath: string): string | null {
  const prefix = dep.startsWith('@/') ? 2 : dep.startsWith('~/') ? 2 : 0;
  if (prefix === 0) return null;
  const sub = dep.slice(prefix); // e.g. 'common' from '@/common'

  let dir = path.dirname(modulePath);
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'src', sub);
    try {
      fs.accessSync(candidate);
      return candidate;
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Detect relative file path patterns (e.g. "list/index.tsx", "api.ts") in a
 * plain-text string and wrap any that actually exist on disk into a
 * glimpse-file: link so markmap renders them as clickable anchors.
 */
function linkifyPaths(text: string, modulePath: string): string {
  // Matches optional leading folder segments + filename with a known extension
  return text.replace(
    /\b((?:[\w-]+\/)*[\w-]+\.(?:tsx|ts|vue|js))\b/g,
    (match) => {
      const absPath = path.join(modulePath, match);
      try {
        fs.accessSync(absPath);
        return `[${match}](glimpse-file:${encodeURIComponent(absPath)})`;
      } catch {
        return match; // file not found — keep as plain text
      }
    }
  );
}
