import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { HypDrivError } from '@hypdriv/core';

export interface FindChromeOptions {
  /** Explicit executable path (highest priority). */
  chromePath?: string | null;
  /** Environment to read `CHROME_PATH` / `PURSER_CHROME` / `PATH` from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** Platform override for tests (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Existence check override for tests. */
  exists?: (path: string) => boolean;
}

export interface FoundChrome {
  path: string;
  source: 'option' | 'env' | 'known-location' | 'path';
}

/** Executable names looked up on `PATH`. */
export const CHROME_PATH_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'chrome',
  'brave-browser',
  'microsoft-edge',
] as const;

/** Well-known installation locations per platform. */
export function knownChromeLocations(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'darwin') {
    const apps = [
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      'Chromium.app/Contents/MacOS/Chromium',
      'Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      'Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    const home = env.HOME ?? homedir();
    return apps.flatMap((app) => [`/Applications/${app}`, join(home, 'Applications', app)]);
  }
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(
      (v): v is string => Boolean(v),
    );
    const rel = [
      'Google\\Chrome\\Application\\chrome.exe',
      'Google\\Chrome SxS\\Application\\chrome.exe',
      'Chromium\\Application\\chrome.exe',
      'Microsoft\\Edge\\Application\\msedge.exe',
      'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
    ];
    return roots.flatMap((root) => rel.map((r) => join(root, r)));
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/bin/chromium',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
    '/opt/google/chrome/google-chrome',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
    '/usr/lib/chromium/chromium',
  ];
}

/**
 * Locates a Chrome/Chromium executable: `chromePath` → `CHROME_PATH` / `PURSER_CHROME` → well-known
 * locations → `PATH` lookup (what `which google-chrome|chromium|chromium-browser` would find).
 */
export function findChrome(options: FindChromeOptions = {}): FoundChrome | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  if (options.chromePath) return exists(options.chromePath) ? { path: options.chromePath, source: 'option' } : null;
  for (const name of ['CHROME_PATH', 'PURSER_CHROME']) {
    const value = env[name];
    if (value && exists(value)) return { path: value, source: 'env' };
  }
  for (const candidate of knownChromeLocations(platform, env)) {
    if (exists(candidate)) return { path: candidate, source: 'known-location' };
  }
  const pathEntries = (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean);
  const names =
    platform === 'win32'
      ? CHROME_PATH_NAMES.flatMap((n) => [`${n}.exe`, `${n}.cmd`, n])
      : [...CHROME_PATH_NAMES];
  for (const dir of pathEntries) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return { path: candidate, source: 'path' };
    }
  }
  return null;
}

export interface LaunchedChrome {
  /** Browser-level DevTools WebSocket URL (`ws://127.0.0.1:<port>/devtools/browser/<id>`). */
  wsUrl: string;
  path: string;
  process: ChildProcess;
  /** Kills Chrome and removes the temporary profile. Safe to call twice. */
  close(): Promise<void>;
}

export interface LaunchChromeOptions {
  path: string;
  /** How long to wait for the DevTools endpoint (default 20 s). */
  timeoutMs?: number;
  /** Extra Chrome flags. */
  args?: string[];
  /** Spawn override for tests. */
  spawn?: typeof spawn;
}

/** Default headless flags. `--no-sandbox` is added when running as root or in CI containers. */
export function chromeArgs(userDataDir: string, extra: string[] = []): string[] {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--window-size=1280,900',
    `--user-data-dir=${userDataDir}`,
  ];
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (uid === 0 || process.env.CI) args.push('--no-sandbox');
  args.push(...extra, 'about:blank');
  return args;
}

/**
 * Starts headless Chrome with a fresh temporary profile on a random debugging port and resolves the
 * browser WebSocket URL printed on stderr (`DevTools listening on ws://…`).
 */
export async function launchChrome(options: LaunchChromeOptions): Promise<LaunchedChrome> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const userDataDir = mkdtempSync(join(tmpdir(), 'hypdriv-chrome-'));
  const doSpawn = options.spawn ?? spawn;
  const child = doSpawn(options.path, chromeArgs(userDataDir, options.args), {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
          resolveWait();
        }, 2_000);
        timer.unref?.();
        child.once('exit', () => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  };

  const wsUrl = await new Promise<string>((resolveUrl, reject) => {
    let buffer = '';
    const fail = async (error: Error) => {
      await close();
      reject(error);
    };
    const timer = setTimeout(() => {
      void fail(
        new HypDrivError('E_TIMEOUT', `Chrome did not expose a DevTools endpoint within ${timeoutMs}ms`, {
          path: options.path,
          stderr: buffer.slice(-2000),
        }),
      );
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (err) => {
      clearTimeout(timer);
      void fail(
        new HypDrivError('E_UNSUPPORTED', `Could not start Chrome at ${options.path}: ${err.message}`, {
          path: options.path,
        }),
      );
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (!closed)
        void fail(
          new HypDrivError('E_UPSTREAM', `Chrome exited before the DevTools endpoint was ready (${code ?? signal})`, {
            path: options.path,
            stderr: buffer.slice(-2000),
          }),
        );
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      buffer += chunk;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buffer);
      if (m) {
        clearTimeout(timer);
        child.stderr?.removeAllListeners('data');
        child.stderr?.resume();
        resolveUrl(m[1]!);
      }
      if (buffer.length > 65_536) buffer = buffer.slice(-16_384);
    });
  });

  return { wsUrl, path: options.path, process: child, close };
}
