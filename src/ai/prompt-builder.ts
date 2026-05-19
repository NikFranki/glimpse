import { ModuleSkeleton } from '../analyzer/types';
import { AIRawOutput, AIRawOutputComponent, AIRawOutputRelation } from './types';

const MAX_FILES = 30;
const MAX_EXPORTS_PER_FILE = 8;
// Only emit deep structural info (Props/State/方法/JSX) for the most relevant files
// to keep the prompt size manageable.
const MAX_DEEP_FILES = 10;

export function buildPrompt(skeleton: ModuleSkeleton): string {
  const lines: string[] = [
    '根据以下前端模块骨架，仅返回 JSON（不要 markdown 代码块，不要额外文字）：',
    '',
    '{',
    '  "responsibilities": ["职责要点1", "职责要点2"],',
    '  "dataFlow": [',
    '    {',
    '      "feature": "功能域名称（如：配置列表、变更日志）",',
    '      "components": [',
    '        {',
    '          "name": "相对文件路径（如 list/index.tsx）",',
    '          "usage": "该文件的用途",',
    '          "deps": ["关键外部依赖"],',
    '          "props": ["关键 prop 名"],',
    '          "state": ["关键 state 变量"],',
    '          "methods": ["关键方法名"],',
    '          "jsx": "界面功能简述",',
    '          "behaviors": [',
    '            "交互因果链，格式：[触发条件] → [数据/逻辑处理] → [结果或副作用]",',
    '            "例：点击确认 → handleOk 校验表单 → 调用 updateConfig API → loading:true → 成功后触发 onOk()"',
    '          ]',
    '        }',
    '      ]',
    '    }',
    '  ],',
    '  "exportDescriptions": { "<导出名>": "一句话描述该导出的功能" },',
    '  "featureRelations": [',
    '    { "from": "功能A名称（与 dataFlow[].feature 完全一致）", "to": "功能B名称", "label": "A→B 的关系，如：通过 taskId 触发、数据来源、状态共享" }',
    '  ]',
    '}',
    '注意：featureRelations 只列功能域间有明确数据/事件依赖的边；无关联则返回 []。',
    '',
    '--- 模块骨架 ---',
    `路径: ${skeleton.modulePath}`,
    `文件数: ${skeleton.files.length}`,
    '',
  ];

  if (skeleton.publicExports.length > 0) {
    lines.push('对外导出:');
    for (const e of skeleton.publicExports) {
      lines.push(`- ${e.name} (${e.kind})`);
    }
    lines.push('');
  }

  if (skeleton.companyDeps.length > 0) {
    lines.push(`公司共享库: ${skeleton.companyDeps.join(', ')}`, '');
  }

  if (skeleton.externalDeps.length > 0) {
    lines.push(`npm 包: ${skeleton.externalDeps.join(', ')}`, '');
  }

  if (skeleton.mfDeps.length > 0) {
    lines.push('MF 跨 App 依赖:');
    for (const dep of skeleton.mfDeps) {
      lines.push(`- ${dep.remote}${dep.exposedPath}`);
    }
    lines.push('');
  }

  const displayFiles = skeleton.files.slice(0, MAX_FILES);
  if (displayFiles.length > 0) {
    lines.push('文件清单:');

    // Files with rich structural info get deep expansion; the rest get one line each.
    // Prioritise files that have props/state/methods (i.e. real components or hooks).
    const [deepCandidates, shallowFiles] = partition(
      displayFiles,
      (f) => !!(f.propsFields?.length || f.stateVars?.length || f.functionNames?.length)
    );
    const deepFiles = deepCandidates.slice(0, MAX_DEEP_FILES);
    // Files that didn't make the deep cut fall back to shallow
    const remainingShallow = [...deepCandidates.slice(MAX_DEEP_FILES), ...shallowFiles];

    for (const f of deepFiles) {
      const exportsStr = f.exports.slice(0, MAX_EXPORTS_PER_FILE).join(', ');
      const nonLocal = [...new Set(
        f.imports.filter((i) => i.kind !== 'local')
          .map((i) => i.source.startsWith('@')
            ? i.source.split('/').slice(0, 2).join('/')
            : i.source.split('/')[0])
      )];
      lines.push(`- ${f.relativePath}${exportsStr ? ' (导出: ' + exportsStr + ')' : ''}`);
      if (nonLocal.length)         lines.push(`  引用: ${nonLocal.join(', ')}`);
      if (f.propsFields?.length)   lines.push(`  Props: ${f.propsFields.join(', ')}`);
      if (f.stateVars?.length)     lines.push(`  State: ${f.stateVars.join(', ')}`);
      if (f.functionNames?.length) lines.push(`  方法: ${f.functionNames.join(', ')}`);
      if (f.jsxElements?.length)   lines.push(`  JSX组件: ${f.jsxElements.join(', ')}`);
    }

    for (const f of remainingShallow) {
      const exportsStr = f.exports.slice(0, MAX_EXPORTS_PER_FILE).join(', ');
      lines.push(`- ${f.relativePath}${exportsStr ? ': ' + exportsStr : ''}`);
    }

    if (skeleton.files.length > MAX_FILES) {
      lines.push(`  ... 及其他 ${skeleton.files.length - MAX_FILES} 个文件`);
    }
  }

  return lines.join('\n');
}

export function parseAIOutput(raw: string): AIRawOutput {
  // 1. Try whole string
  const direct = tryParse(raw);
  if (direct) return validate(direct);

  // 2. Fenced code block
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    const fromFence = tryParse(fenced[1]);
    if (fromFence) return validate(fromFence);
  }

  // 3. First { ... } span
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const fromSpan = tryParse(raw.slice(start, end + 1));
    if (fromSpan) return validate(fromSpan);
  }

  throw new Error(`AI 返回了无法解析的 JSON：${raw.slice(0, 200)}`);
}

function partition<T>(arr: T[], pred: (x: T) => boolean): [T[], T[]] {
  const yes: T[] = [], no: T[] = [];
  for (const x of arr) (pred(x) ? yes : no).push(x);
  return [yes, no];
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toStrArr(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map((x) => String(x)) : [];
}

function validateComponent(c: unknown): AIRawOutputComponent {
  const comp = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
  return {
    name: String(comp['name'] ?? ''),
    usage: String(comp['usage'] ?? ''),
    deps: toStrArr(comp['deps']),
    props: toStrArr(comp['props']),
    state: toStrArr(comp['state']),
    methods: toStrArr(comp['methods']),
    jsx: typeof comp['jsx'] === 'string' ? comp['jsx'] : undefined,
    behaviors: toStrArr(comp['behaviors']).filter(Boolean),
  };
}

function validate(data: unknown): AIRawOutput {
  if (typeof data !== 'object' || data === null) {
    throw new Error('AI 输出不是对象');
  }
  const obj = data as Record<string, unknown>;

  // responsibilities: new format; fall back if model returns old "responsibility" string
  const responsibilities: string[] = Array.isArray(obj['responsibilities'])
    ? toStrArr(obj['responsibilities'])
    : typeof obj['responsibility'] === 'string'
    ? [obj['responsibility']]
    : ['（未能解析）'];

  const dataFlow = Array.isArray(obj['dataFlow'])
    ? (obj['dataFlow'] as unknown[]).map((item) => {
        const f = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
        return {
          feature: String(f['feature'] ?? ''),
          components: Array.isArray(f['components'])
            ? (f['components'] as unknown[]).map(validateComponent)
            : [],
        };
      })
    : [];

  const exportDescriptions: Record<string, string> =
    typeof obj['exportDescriptions'] === 'object' && obj['exportDescriptions'] !== null
      ? Object.fromEntries(
          Object.entries(obj['exportDescriptions'] as Record<string, unknown>).map(([k, v]) => [
            k,
            String(v),
          ])
        )
      : {};

  const featureRelations: AIRawOutputRelation[] = Array.isArray(obj['featureRelations'])
    ? (obj['featureRelations'] as unknown[]).flatMap((r) => {
        const rel = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
        const from = String(rel['from'] ?? '').trim();
        const to = String(rel['to'] ?? '').trim();
        return from && to && from !== to
          ? [{ from, to, label: String(rel['label'] ?? '') }]
          : [];
      })
    : [];

  return { responsibilities, dataFlow, exportDescriptions, featureRelations };
}
