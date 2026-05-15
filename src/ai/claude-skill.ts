import { spawn } from 'child_process';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AISkill } from './types';

const execFileAsync = promisify(execFile);

export class ClaudeSkill implements AISkill {
  readonly name = 'claude';

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['claude']);
      return true;
    } catch {
      return false;
    }
  }

  run(prompt: string): Promise<string> {
    return spawnAndCollect('claude', ['--print', prompt]);
  }
}

export function spawnAndCollect(cmd: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${cmd} 调用超时（${timeoutMs / 1000}s）`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`${cmd} 退出码 ${code ?? 'null'}：${stderr.slice(0, 300)}`));
      }
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new Error(`${cmd} 启动失败: ${err.message}`));
    });
  });
}
