import { ModuleAnalysis } from '../analyzer/types';

export interface FeatureGraphData {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label: string; source: string }>;
}

// Extension → Webview
export type ExtensionToWebviewMessage =
  | { type: 'loading'; modulePath: string }
  | { type: 'progress'; step: string }
  | { type: 'error'; message: string; modulePath?: string }
  | { type: 'data'; analysis: ModuleAnalysis };

// Webview → Extension
export type WebviewToExtensionMessage =
  | { type: 'openFile'; filePath: string }
  | { type: 'openFolder'; folderPath: string }
  | { type: 'openUrl'; url: string }
  | { type: 'drillDown'; folderPath: string };
