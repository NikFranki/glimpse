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

  // ── 对外暴露 ──────────────────────────────────────────────
  if (analysis.publicExports.length > 0) {
    lines.push('', '## 对外暴露');
    for (const e of analysis.publicExports) {
      const desc = analysis.exportDescriptions[e.name] ?? '';
      const encoded = encodeURIComponent(e.filePath);
      const label = desc ? `${e.name} — ${desc}` : e.name;
      lines.push(`- [${label} *(${e.kind})*](glimpse-file:${encoded})`);
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
        lines.push(`  - ${dep}`);
      }
    }

    if (analysis.companyDeps.length > 0) {
      lines.push('', '- 公司共享库');
      for (const dep of analysis.companyDeps) {
        lines.push(`  - ${dep}`);
      }
    }

    if (analysis.externalDeps.length > 0) {
      lines.push('', '- npm 包');
      for (const dep of analysis.externalDeps) {
        lines.push(`  - ${dep}`);
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
