import { spawn } from 'node:child_process';

/** Result of a spawned process. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Kill the process after this many milliseconds (default: no limit). */
  timeoutMs?: number;
}

/**
 * Everything a command touches outside its own logic. Tests inject fakes so no command ever reaches the
 * network, spawns a process or depends on the real terminal.
 */
export interface IO {
  stdout: { write(text: string): void };
  stderr: { write(text: string): void };
  cwd: string;
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  /** Whether stdout is an interactive terminal (drives colours). */
  isTTY: boolean;
  /** Monotonic clock in milliseconds. */
  now(): number;
  /** Wall clock. */
  date(): Date;
  /** Resolves when the user interrupts (SIGINT); long-running commands await it. */
  interrupted(): Promise<void>;
}

/** Spawns a process and collects its output. Never throws for a missing binary (code 127). */
export function nodeExec(command: string, args: string[], options: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: { ...process.env, ...(options.env ?? {}) } as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: (err as Error).message });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (code: number) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const timer = options.timeoutMs
      ? setTimeout(() => {
          stderr += `\n[hypdriv] process timed out after ${options.timeoutMs} ms`;
          child.kill('SIGTERM');
          done(124);
        }, options.timeoutMs)
      : null;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      stderr += err.message;
      done((err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 1);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

/** The real-world IO used by the `hypdriv` binary. */
export function createNodeIO(overrides: Partial<IO> = {}): IO {
  return {
    stdout: { write: (text) => process.stdout.write(text) },
    stderr: { write: (text) => process.stderr.write(text) },
    cwd: process.cwd(),
    env: process.env,
    fetch: (input, init) => globalThis.fetch(input, init),
    exec: nodeExec,
    isTTY: Boolean(process.stdout.isTTY),
    now: () => performance.now(),
    date: () => new Date(),
    interrupted: () =>
      new Promise((resolve) => {
        process.once('SIGINT', () => resolve());
        process.once('SIGTERM', () => resolve());
      }),
    ...overrides,
  };
}

/** Captured IO for tests and programmatic callers. */
export interface MemoryIO extends IO {
  readonly out: string;
  readonly err: string;
  reset(): void;
}

export interface MemoryIOOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  exec?: IO['exec'];
  isTTY?: boolean;
  now?: () => number;
  date?: () => Date;
}

/**
 * An in-memory IO whose network and process seams fail loudly unless a test provides them.
 */
export function createMemoryIO(options: MemoryIOOptions = {}): MemoryIO {
  let out = '';
  let err = '';
  const io: MemoryIO = {
    stdout: {
      write(text) {
        out += text;
      },
    },
    stderr: {
      write(text) {
        err += text;
      },
    },
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? {},
    fetch:
      options.fetch ??
      (async () => {
        throw new Error('network access is not available in this context');
      }),
    exec:
      options.exec ??
      (async (command) => ({
        code: 127,
        stdout: '',
        stderr: `exec is not available in this context (${command})`,
      })),
    isTTY: options.isTTY ?? false,
    now: options.now ?? (() => performance.now()),
    date: options.date ?? (() => new Date()),
    interrupted: () => new Promise(() => {}),
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    reset() {
      out = '';
      err = '';
    },
  };
  return io;
}
