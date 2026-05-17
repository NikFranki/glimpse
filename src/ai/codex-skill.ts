import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import { AISkill } from './types';
import { spawnAndCollect } from './claude-skill';

const execFileAsync = promisify(execFile);

// Known macOS app bundle path — handles alias-only installs where `spawn`
// can't resolve the shell alias.
const CODEX_BIN_PATHS = [
  '/Applications/Codex.app/Contents/Resources/codex',
];

export class CodexSkill implements AISkill {
  readonly name = 'codex';
  private binPath: string | null = null;

  async isAvailable(): Promise<boolean> {
    for (const p of CODEX_BIN_PATHS) {
      if (fs.existsSync(p)) {
        this.binPath = p;
        return true;
      }
    }
    try {
      const { stdout } = await execFileAsync('bash', ['-lc', 'command -v codex']);
      const resolved = stdout.trim();
      if (resolved) { this.binPath = resolved; return true; }
    } catch {}
    return false;
  }

  run(prompt: string): Promise<string> {
    const bin = this.binPath ?? 'codex';
    // `exec` runs non-interactively; `--ephemeral` skips session persistence;
    // `--color never` strips ANSI codes; `-` reads prompt from stdin.
    return spawnAndCollect(bin, ['exec', '--ephemeral', '--color', 'never', '-'], prompt)
      .then(extractModelResponse);
  }
}

// codex exec stdout format:
//   <header block>
//   user
//   <prompt>
//   codex
//   <model response>
// Extract everything after the first standalone "codex" line.
function extractModelResponse(raw: string): string {
  const match = raw.match(/^codex\s*\n([\s\S]*)/m);
  return match ? match[1].trim() : raw;
}
