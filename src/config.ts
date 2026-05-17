import * as vscode from 'vscode';

export type AIProvider = 'auto' | 'claude' | 'codex';

export function getAIProvider(): AIProvider {
  return (
    vscode.workspace.getConfiguration('glimpse').get<AIProvider>('aiProvider') ?? 'auto'
  );
}

const DEFAULT_COMPANY_SCOPES = ['@scfe', '@spx', '@ssc', '@sc/', 'ssc-', 'sc-cli', 'react-pro-components'];

export function getCompanyScopes(): string[] {
  return (
    vscode.workspace
      .getConfiguration('glimpse')
      .get<string[]>('companyScopes') ?? DEFAULT_COMPANY_SCOPES
  );
}

// Haiku by default: ~5-8x faster than Sonnet for structured JSON extraction.
const DEFAULT_CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

export function getClaudeModel(): string {
  return (
    vscode.workspace.getConfiguration('glimpse').get<string>('claudeModel') ?? DEFAULT_CLAUDE_MODEL
  );
}
