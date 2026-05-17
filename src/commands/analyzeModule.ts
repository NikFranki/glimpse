import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GlimpseViewProvider } from '../webview/provider';
import { analyzeModule } from '../analyzer/index';
import { detectSkill } from '../ai/detector';
import { buildPrompt, parseAIOutput } from '../ai/prompt-builder';
import { getAIProvider, getClaudeModel, getCompanyScopes } from '../config';
import { ModuleAnalysis, ModuleSkeleton } from '../analyzer/types';

function staticFallback(skeleton: ModuleSkeleton, reason?: string): ModuleAnalysis {
  const label = reason ? `（AI 失败：${reason}）` : '（仅静态分析，AI 未运行）';
  return {
    ...skeleton,
    ai: { responsibilities: [label], dataFlow: [] },
    exportDescriptions: {},
  };
}

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
        const isFile = fs.statSync(uri.fsPath).isFile();
        const modulePath = isFile ? path.dirname(uri.fsPath) : uri.fsPath;
        const targetFile = isFile ? uri.fsPath : undefined;

        progress.report({ message: '扫描文件…' });
        provider.postMessage({ type: 'progress', step: '扫描文件结构…' });
        const skeleton = await analyzeModule(modulePath, getCompanyScopes(), targetFile);

        const fileCount = skeleton.files.length;
        provider.postMessage({ type: 'progress', step: `静态分析完成（${fileCount} 个文件）` });

        progress.report({ message: '检测 AI CLI…' });
        provider.postMessage({ type: 'progress', step: '检测 AI CLI…' });
        const skill = await detectSkill(getAIProvider(), getClaudeModel());

        let analysis: ModuleAnalysis;

        if (skill) {
          provider.postMessage({ type: 'progress', step: `AI 语义分析中（${skill.name}）…` });
          progress.report({ message: `AI 分析中（${skill.name}）…` });
          try {
            const prompt = buildPrompt(skeleton);
            const rawOutput = await skill.run(prompt);
            const aiOutput = parseAIOutput(rawOutput);
            provider.postMessage({ type: 'progress', step: 'AI 分析完成' });
            analysis = {
              ...skeleton,
              ai: {
                responsibilities: aiOutput.responsibilities,
                dataFlow: aiOutput.dataFlow,
              },
              exportDescriptions: aiOutput.exportDescriptions,
            };
          } catch (aiErr) {
            const aiMsg = aiErr instanceof Error ? aiErr.message : String(aiErr);
            provider.postMessage({ type: 'progress', step: 'AI 分析失败，使用静态分析兜底' });
            vscode.window.showWarningMessage(`Glimpse: AI 分析失败（${aiMsg.slice(0, 120)}）`);
            analysis = staticFallback(skeleton, aiMsg.slice(0, 200));
          }
        } else {
          const picked = await vscode.window.showWarningMessage(
            'Glimpse: 未检测到 claude 或 codex CLI，仅显示静态分析结果',
            '打开设置'
          );
          if (picked === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'glimpse.aiProvider');
          }
          analysis = staticFallback(skeleton, '未检测到 AI CLI');
        }

        progress.report({ message: '渲染中…' });
        provider.postMessage({ type: 'progress', step: '构建思维导图…' });
        provider.postMessage({ type: 'data', analysis });
      }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    provider.postMessage({ type: 'error', message, modulePath: uri.fsPath });
  }
}
