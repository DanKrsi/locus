// Runs git: the copy bundled with the app (dugite) when available, otherwise the system's git.
// The desktop app always has dugite; the Claude Code plugin may run without it.
import { execFile } from 'node:child_process';

export interface GitResult<T extends string | Buffer = string> {
  stdout: T;
  stderr: T;
  exitCode: number;
}

interface Options {
  env?: Record<string, string | undefined>;
  maxBuffer?: number;
}

type Dugite = typeof import('dugite');
let dugite: Dugite | null | undefined;

async function loadDugite(): Promise<Dugite | null> {
  if (dugite === undefined) {
    try {
      dugite = await import('dugite');
    } catch {
      dugite = null;
    }
  }
  return dugite;
}

function systemGit(args: string[], cwd: string, opts: Options & { encoding: 'buffer' | 'utf8' }): Promise<GitResult<string | Buffer>> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: opts.env ? { ...process.env, ...opts.env } : process.env,
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
        encoding: opts.encoding,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0;
        resolve({ stdout, stderr, exitCode: code });
      },
    );
  });
}

export async function exec(args: string[], cwd: string, opts?: Options & { encoding?: 'utf8' }): Promise<GitResult<string>>;
export async function exec(args: string[], cwd: string, opts: Options & { encoding: 'buffer' }): Promise<GitResult<Buffer>>;
export async function exec(args: string[], cwd: string, opts: Options & { encoding?: 'utf8' | 'buffer' } = {}): Promise<GitResult<string | Buffer>> {
  const d = await loadDugite();
  const encoding = opts.encoding ?? 'utf8';
  if (d) {
    return d.exec(args, cwd, { env: opts.env, maxBuffer: opts.maxBuffer, encoding: encoding as 'buffer' }) as Promise<GitResult<string | Buffer>>;
  }
  return systemGit(args, cwd, { ...opts, encoding });
}
