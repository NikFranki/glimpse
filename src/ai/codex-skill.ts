import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
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

  async run(prompt: string): Promise<string> {
    const bin = this.binPath ?? 'codex';
    // --output-last-message writes only the model's final response to a temp
    // file, bypassing the noisy header / hook / token lines in stdout.
    const tmpFile = path.join(os.tmpdir(), `codex-${crypto.randomBytes(6).toString('hex')}.txt`);
    try {
      await spawnAndCollect(
        bin,
        ['exec', '--ephemeral', '--color', 'never', '--skip-git-repo-check', '--output-last-message', tmpFile, '-'],
        prompt
      );
      return fs.readFileSync(tmpFile, 'utf8').trim();
    } finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }
}
