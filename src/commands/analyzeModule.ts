import * as vscode from 'vscode';
import { GlimpseViewProvider } from '../webview/provider';
import { analyzeModule } from '../analyzer/index';
import { detectSkill } from '../ai/detector';
import { buildPrompt, parseAIOutput } from '../ai/prompt-builder';
import { getAIProvider, getCompanyScopes } from '../config';
import { ModuleAnalysis } from '../analyzer/types';

export async function analyzeModuleCommand(
  provider: GlimpseViewProvider,
  uri: vscode.Uri
): Promise<void> {
  await provider.focusView();
  provider.postMessage({ type: 'loading', modulePath: uri.fsPath });

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Glimpse',
        cancellable: false,
      },
      async (progress) => {
        progress.report({ message: '扫描文件…' });
        const skeleton = await analyzeModule(uri.fsPath, getCompanyScopes());

        progress.report({ message: '检测 AI CLI…' });
        const skill = await detectSkill(getAIProvider());

        let analysis: ModuleAnalysis;

        if (skill) {
          progress.report({ message: `AI 分析中（${skill.name}）…` });
          const prompt = buildPrompt(skeleton);
          const rawOutput = await skill.run(prompt);
          const aiOutput = parseAIOutput(rawOutput);

          analysis = {
            ...skeleton,
            ai: {
              responsibilities: aiOutput.responsibilities,
              dataFlow: aiOutput.dataFlow,
            },
            exportDescriptions: aiOutput.exportDescriptions,
          };
        } else {
          const picked = await vscode.window.showWarningMessage(
            'Glimpse: 未检测到 claude 或 codex CLI，仅显示静态分析结果',
            '打开设置'
          );
          if (picked === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'glimpse.aiProvider');
          }
          analysis = {
            ...skeleton,
            ai: { responsibilities: ['（未检测到 AI CLI，仅显示静态分析）'], dataFlow: [] },
            exportDescriptions: {},
          };
        }

        progress.report({ message: '渲染中…' });
        provider.postMessage({ type: 'data', analysis });
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    provider.postMessage({ type: 'error', message, modulePath: uri.fsPath });
  }
}
