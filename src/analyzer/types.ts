export type FileType = 'ts' | 'tsx' | 'vue' | 'js';

export interface ImportRef {
  source: string;
  kind: 'local' | 'thirdParty' | 'mf';
  names: string[];
}

export interface FileInfo {
  relativePath: string;
  type: FileType;
  exports: string[];
  imports: ImportRef[];
  // Static deep analysis — populated by react/vue analyzer when available
  propsFields?: string[];    // from Props interface / type definition
  stateVars?: string[];      // from useState() / Vue data()
  functionNames?: string[];  // camelCase function/method declarations
  jsxElements?: string[];    // uppercase component tags used in JSX/template
}

export type ExportKind = 'component' | 'hook' | 'util' | 'type' | 'unknown';

export interface ExportInfo {
  name: string;
  kind: ExportKind;
  filePath: string;
}

export interface MFDep {
  remote: string;
  exposedPath: string;
}

export interface ModuleSkeleton {
  modulePath: string;
  files: FileInfo[];
  publicExports: ExportInfo[];
  externalDeps: string[];   // public npm packages
  companyDeps: string[];    // company-internal packages (matched by glimpse.companyScopes)
  mfDeps: MFDep[];
}

export interface DataFlowComponent {
  name: string;          // relative file path, e.g. "list/index.tsx"
  usage: string;         // 用途
  deps?: string[];       // 引入的关键依赖
  props?: string[];      // 定义的属性
  state?: string[];      // 状态变量
  methods?: string[];    // 方法列表
  jsx?: string;          // JSX/template 功能描述
  behaviors?: string[];  // 交互因果链：触发 → 处理 → 结果
}

export interface DataFlowFeature {
  feature: string;                  // 功能域, e.g. "配置列表"
  components: DataFlowComponent[];
}

export interface AIOutput {
  responsibilities: string[];    // 职责要点列表，每条独立节点
  dataFlow: DataFlowFeature[];   // 按功能域分组的组件解析
}

export interface ModuleAnalysis extends ModuleSkeleton {
  ai: AIOutput;
  exportDescriptions: Record<string, string>;
}
