import type { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import vm from 'node:vm';
import { HypDrivError } from '@hypdriv/core';
import { describe, expect, it } from 'vitest';
import { type CdpConnect, type CdpTransport, createCdpClient, decodeFrame, encodeCommand } from './cdp';
import { chromeArgs, findChrome, launchChrome } from './chrome';
import { auditOverrides, formatAuditReport, wrapStrikeScript } from './index';

// ---------------------------------------------------------------------------
// Chrome discovery
// ---------------------------------------------------------------------------

describe('findChrome', () => {
  const existsIn = (paths: string[]) => (p: string) => paths.includes(p);

  it('prefers the explicit path, then env, then known locations, then PATH', () => {
    expect(findChrome({ chromePath: '/opt/c', exists: existsIn(['/opt/c']) })).toEqual({
      path: '/opt/c',
      source: 'option',
    });
    expect(
      findChrome({ chromePath: '/missing', exists: existsIn(['/usr/bin/google-chrome']), env: {} }),
    ).toBeNull();
    expect(
      findChrome({
        env: { CHROME_PATH: '/env/chrome' },
        exists: existsIn(['/env/chrome']),
        platform: 'linux',
      }),
    ).toEqual({
      path: '/env/chrome',
      source: 'env',
    });
    expect(
      findChrome({ env: {}, exists: existsIn(['/usr/bin/chromium-browser']), platform: 'linux' }),
    ).toEqual({
      path: '/usr/bin/chromium-browser',
      source: 'known-location',
    });
    expect(
      findChrome({ env: { PATH: '/a:/b' }, exists: existsIn(['/b/google-chrome']), platform: 'linux' }),
    ).toEqual({ path: '/b/google-chrome', source: 'path' });
    expect(
      findChrome({
        env: { HOME: '/Users/me' },
        exists: existsIn(['/Users/me/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']),
        platform: 'darwin',
      })?.source,
    ).toBe('known-location');
    expect(
      findChrome({
        env: { PROGRAMFILES: 'C:\\Program Files', PATH: '' },
        exists: existsIn(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']),
        platform: 'win32',
      })?.path,
    ).toContain('chrome.exe');
    expect(findChrome({ env: { PATH: '/nowhere' }, exists: () => false, platform: 'linux' })).toBeNull();
    expect(
      findChrome({
        chromePath: 'chromium',
        env: { PATH: '/a:/b' },
        exists: existsIn(['/b/chromium']),
        platform: 'linux',
      }),
    ).toEqual({ path: '/b/chromium', source: 'option' });
    expect(
      findChrome({ chromePath: 'chromium', env: { PATH: '/a' }, exists: () => false, platform: 'linux' }),
    ).toBeNull();
  });

  it('builds headless flags with a private profile', () => {
    const args = chromeArgs('/tmp/profile', ['--lang=en']);
    expect(args).toContain('--headless=new');
    expect(args).toContain('--remote-debugging-port=0');
    expect(args).toContain('--user-data-dir=/tmp/profile');
    expect(args).toContain('--lang=en');
    expect(args[args.length - 1]).toBe('about:blank');
  });
});

// ---------------------------------------------------------------------------
// Chrome launch (fake child process)
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  stderr: PassThrough;
  exitCode: number | null;
  killed: boolean;
  signals: string[];
  kill(signal?: NodeJS.Signals | number): boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.signals = [];
  child.kill = (signal = 'SIGTERM') => {
    child.signals.push(String(signal));
    child.killed = true;
    child.exitCode = 0;
    setImmediate(() => child.emit('exit', 0, null));
    return true;
  };
  return child;
}

function fakeSpawn(behaviour: (child: FakeChild) => void) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const impl = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const child = fakeChild();
    behaviour(child);
    return child as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { spawn: impl, calls };
}

describe('launchChrome', () => {
  it('parses the DevTools endpoint from stderr and cleans up on close', async () => {
    const { spawn: spawnImpl, calls } = fakeSpawn((child) => {
      setTimeout(() => {
        child.stderr.write('[warn] something\n');
        child.stderr.write('DevTools listening on ws://127.0.0.1:9333/devtools/browser/abc-123\n');
      }, 5);
    });
    const chrome = await launchChrome({ path: '/fake/chrome', spawn: spawnImpl });
    expect(chrome.wsUrl).toBe('ws://127.0.0.1:9333/devtools/browser/abc-123');
    expect(calls[0]!.cmd).toBe('/fake/chrome');
    const profile = calls[0]!.args
      .find((a) => a.startsWith('--user-data-dir='))!
      .slice('--user-data-dir='.length);
    expect(existsSync(profile)).toBe(true);
    await chrome.close();
    await chrome.close();
    expect((chrome.process as unknown as FakeChild).signals).toEqual(['SIGTERM']);
    expect(existsSync(profile)).toBe(false);
  });

  it('times out and kills Chrome when no endpoint appears', async () => {
    const { spawn: spawnImpl } = fakeSpawn(() => {});
    await expect(
      launchChrome({ path: '/fake/chrome', spawn: spawnImpl, timeoutMs: 30 }),
    ).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
  });

  it('reports an early exit and spawn errors', async () => {
    const exits = fakeSpawn((child) => setTimeout(() => child.emit('exit', 1, null), 5));
    await expect(launchChrome({ path: '/fake/chrome', spawn: exits.spawn })).rejects.toMatchObject({
      code: 'E_UPSTREAM',
    });
    const errors = fakeSpawn((child) => setTimeout(() => child.emit('error', new Error('ENOENT')), 5));
    await expect(launchChrome({ path: '/fake/chrome', spawn: errors.spawn })).rejects.toMatchObject({
      code: 'E_UNSUPPORTED',
    });
  });
});

// ---------------------------------------------------------------------------
// CDP client over an in-memory transport
// ---------------------------------------------------------------------------

function memoryTransport() {
  const sent: Array<Record<string, unknown>> = [];
  let onMessage: (data: string) => void = () => {};
  let onClose: (reason?: string) => void = () => {};
  const transport: CdpTransport = {
    send(data) {
      sent.push(JSON.parse(data) as Record<string, unknown>);
    },
    onMessage(h) {
      onMessage = h;
    },
    onClose(h) {
      onClose = h;
    },
    close() {
      onClose('closed by client');
    },
  };
  return {
    transport,
    sent,
    receive: (frame: unknown) => onMessage(typeof frame === 'string' ? frame : JSON.stringify(frame)),
    drop: (reason?: string) => onClose(reason),
  };
}

describe('createCdpClient', () => {
  it('frames commands, routes responses, errors and events', async () => {
    const { transport, sent, receive } = memoryTransport();
    const client = createCdpClient(transport, { timeoutMs: 200 });
    const pending = client.send<{ ok: boolean }>('Page.navigate', { url: 'http://x/' }, 'S1');
    expect(sent[0]).toEqual({
      id: 1,
      method: 'Page.navigate',
      params: { url: 'http://x/' },
      sessionId: 'S1',
    });
    receive({ id: 1, result: { ok: true }, sessionId: 'S1' });
    expect(await pending).toEqual({ ok: true });

    const failing = client.send('Runtime.evaluate');
    receive({ id: 2, error: { code: -32000, message: 'boom' } });
    await expect(failing).rejects.toMatchObject({ code: 'E_UPSTREAM', message: 'Runtime.evaluate: boom' });

    const seen: string[] = [];
    const off = client.on('Page.loadEventFired', (e) => seen.push(e.sessionId ?? '-'));
    const waited = client.waitFor('Page.loadEventFired', { sessionId: 'S2' });
    receive({ method: 'Page.loadEventFired', params: {}, sessionId: 'S1' });
    receive({ method: 'Page.loadEventFired', params: { timestamp: 2 }, sessionId: 'S2' });
    expect((await waited).params).toEqual({ timestamp: 2 });
    expect(seen).toEqual(['S1', 'S2']);
    off();
    receive('not json');
    receive({ id: 999, result: {} });
    receive({ method: 'Page.loadEventFired', params: {} });
    expect(seen).toEqual(['S1', 'S2']);

    const slow = client.send('Slow.command');
    await expect(slow).rejects.toMatchObject({ code: 'E_TIMEOUT' });
    await expect(client.waitFor('Never.happens', { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'E_TIMEOUT',
    });
    client.close();
    expect(client.closed).toBe(true);
    await expect(client.send('After.close')).rejects.toMatchObject({ code: 'E_UPSTREAM' });
  });

  it('rejects pending commands when the transport drops', async () => {
    const { transport, drop } = memoryTransport();
    const client = createCdpClient(transport, { timeoutMs: 1000 });
    const pending = client.send('Target.createTarget');
    drop('socket hang up');
    await expect(pending).rejects.toMatchObject({
      code: 'E_UPSTREAM',
      message: expect.stringContaining('socket hang up'),
    });
    expect(client.closed).toBe(true);
  });

  it('encodes and decodes frames', () => {
    expect(JSON.parse(encodeCommand(3, 'Page.enable'))).toEqual({ id: 3, method: 'Page.enable', params: {} });
    expect(decodeFrame('{"id":1,"result":{"a":1}}')).toEqual({
      kind: 'response',
      id: 1,
      result: { a: 1 },
      error: undefined,
      sessionId: undefined,
    });
    expect(decodeFrame('{"method":"X.y","params":{"z":1},"sessionId":"S"}')).toEqual({
      kind: 'event',
      method: 'X.y',
      params: { z: 1 },
      sessionId: 'S',
    });
    expect(decodeFrame('[]')).toEqual({ kind: 'invalid' });
    expect(decodeFrame('nope')).toEqual({ kind: 'invalid' });
  });
});

// ---------------------------------------------------------------------------
// Full audit against a fake DevTools endpoint
// ---------------------------------------------------------------------------

interface FakeDevToolsOptions {
  navigateError?: string;
  strike?: (state: { navigations: number; hovered: boolean; focused: boolean }) => Record<string, unknown>;
}

function fakeDevTools(options: FakeDevToolsOptions = {}) {
  const log: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = [];
  const state = { navigations: 0, hovered: false, focused: false, themes: [] as string[] };
  const connect: CdpConnect = async () => {
    let onMessage: (data: string) => void = () => {};
    let onClose: (reason?: string) => void = () => {};
    const transport: CdpTransport = {
      send(data) {
        const msg = JSON.parse(data) as {
          id: number;
          method: string;
          params: Record<string, unknown>;
          sessionId?: string;
        };
        log.push({ method: msg.method, params: msg.params, sessionId: msg.sessionId });
        const reply = (result: unknown) =>
          queueMicrotask(() => onMessage(JSON.stringify({ id: msg.id, result, sessionId: msg.sessionId })));
        switch (msg.method) {
          case 'Browser.getVersion':
            return reply({ product: 'HeadlessChrome/130.0.6723.58' });
          case 'Target.createTarget':
            return reply({ targetId: 'T1' });
          case 'Target.attachToTarget':
            return reply({ sessionId: 'S1' });
          case 'Page.navigate':
            state.navigations++;
            state.hovered = false;
            state.focused = false;
            if (options.navigateError) return reply({ frameId: 'F', errorText: options.navigateError });
            reply({ frameId: 'F', loaderId: 'L' });
            setTimeout(
              () =>
                onMessage(
                  JSON.stringify({
                    method: 'Page.loadEventFired',
                    params: { timestamp: 1 },
                    sessionId: 'S1',
                  }),
                ),
              1,
            );
            return;
          case 'Input.dispatchMouseEvent':
            state.hovered = true;
            return reply({});
          case 'Runtime.evaluate': {
            const expr = String(msg.params.expression);
            let value: unknown;
            if (expr.includes('purserStrikeCount')) {
              value = JSON.stringify(
                options.strike?.(state) ?? { count: 0, struck: [], rules: 3, skipped: [] },
              );
            } else if (expr.includes('scrollIntoView')) value = { found: true, x: 10.4, y: 20.6, tag: 'a' };
            else if (expr.includes('activeElement')) {
              state.focused = true;
              value = { focused: true, focusVisible: true, tag: 'a' };
            } else if (expr.includes('classList')) {
              const add = /add=(\[[^\]]*\])/.exec(expr)?.[1] ?? '[]';
              state.themes.push(add);
              value = 'x';
            }
            return reply({ result: { type: typeof value, value } });
          }
          default:
            return reply({});
        }
      },
      onMessage(h) {
        onMessage = h;
      },
      onClose(h) {
        onClose = h;
      },
      close() {
        onClose('closed');
      },
    };
    return transport;
  };
  return { connect, log, state };
}

function fakeLauncher() {
  const calls = { launched: 0, closed: 0 };
  const launch = async () => {
    calls.launched++;
    return {
      wsUrl: 'ws://127.0.0.1:1/devtools/browser/fake',
      path: '/fake/chrome',
      process: {} as ChildProcess,
      close: async () => {
        calls.closed++;
      },
    };
  };
  return { launch, calls };
}

const STRIKE_STUB =
  '(function install(global){ global.purserStrikeCount = function(){ return { struck: [], count: 0, rules: 7, skipped: [] }; }; })(globalThis);\npurserStrikeCount();';

describe('auditOverrides', () => {
  it('throws E_UNSUPPORTED when no Chrome can be found', async () => {
    await expect(
      auditOverrides({
        urls: ['http://x/'],
        widths: [360],
        states: ['default'],
        chromePath: '/definitely/not/chrome',
      }),
    ).rejects.toMatchObject({ code: 'E_UNSUPPORTED', message: expect.stringContaining('CHROME_PATH') });
  });

  it('drives one target through widths, themes and states and reports clean pages', async () => {
    const devtools = fakeDevTools();
    const launcher = fakeLauncher();
    const report = await auditOverrides({
      urls: ['http://a.test/', 'http://a.test/blog'],
      widths: [360, 1280],
      states: ['focus', 'hover', 'default'],
      themeClasses: [[], ['dark']],
      chromePath: process.execPath,
      strikeScript: STRIKE_STUB,
      launch: launcher.launch,
      connect: devtools.connect,
      timeoutMs: 2000,
    });
    expect(report.ok).toBe(true);
    expect(report.checks).toBe(2 * 2 * 2 * 3);
    expect(report.chrome).toEqual({ path: process.execPath, version: 'HeadlessChrome/130.0.6723.58' });
    expect(report.pages[0]).toMatchObject({
      url: 'http://a.test/',
      width: 360,
      theme: [],
      state: 'default',
      count: 0,
      rules: 3,
    });
    expect(report.pages.map((p) => p.state).slice(0, 3)).toEqual(['default', 'hover', 'focus']);
    expect(devtools.state.navigations).toBe(8);
    expect(devtools.state.themes.filter((t) => t === '["dark"]')).toHaveLength(4);
    const methods = devtools.log.map((l) => l.method);
    expect(methods.slice(0, 5)).toEqual([
      'Browser.getVersion',
      'Target.createTarget',
      'Target.attachToTarget',
      'Page.enable',
      'Runtime.enable',
    ]);
    expect(methods.slice(-2)).toEqual(['Target.closeTarget', 'Browser.close']);
    const metrics = devtools.log
      .filter((l) => l.method === 'Emulation.setDeviceMetricsOverride')
      .map((l) => l.params);
    expect(metrics).toEqual([
      { width: 360, height: 900, deviceScaleFactor: 1, mobile: true },
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
      { width: 360, height: 900, deviceScaleFactor: 1, mobile: true },
      { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    ]);
    const mouse = devtools.log.find((l) => l.method === 'Input.dispatchMouseEvent');
    expect(mouse?.params).toEqual({ type: 'mouseMoved', x: 10, y: 21 });
    expect(mouse?.sessionId).toBe('S1');
    expect(devtools.log.filter((l) => l.method === 'Input.dispatchKeyEvent')).toHaveLength(2 * 8);
    expect(launcher.calls).toEqual({ launched: 1, closed: 1 });
    expect(formatAuditReport(report)).toContain('ok: 24 checks');
  });

  it('fails the report on overrides and records navigation errors, always closing Chrome', async () => {
    const struck = fakeDevTools({
      strike: (s) =>
        s.hovered
          ? {
              count: 1,
              struck: [{ element: 'a.x1', pseudo: '', property: 'color', sources: ['.x1', '.x2:hover'] }],
              rules: 3,
              skipped: ['@container card'],
            }
          : { count: 0, struck: [], rules: 3, skipped: [] },
    });
    const launcher = fakeLauncher();
    const report = await auditOverrides({
      urls: ['http://a.test/'],
      widths: [800],
      states: ['default', 'hover'],
      chromePath: process.execPath,
      strikeScript: STRIKE_STUB,
      launch: launcher.launch,
      connect: struck.connect,
    });
    expect(report.ok).toBe(false);
    expect(report.pages.map((p) => p.count)).toEqual([0, 1]);
    expect(report.pages[1]!.skipped).toEqual(['@container card']);
    expect(formatAuditReport(report)).toContain('a.x1 color ← .x1 | .x2:hover');
    expect(launcher.calls.closed).toBe(1);

    const broken = fakeDevTools({ navigateError: 'net::ERR_CONNECTION_REFUSED' });
    const launcher2 = fakeLauncher();
    const failed = await auditOverrides({
      urls: ['http://down.test/'],
      widths: [800],
      states: ['default', 'hover'],
      chromePath: process.execPath,
      strikeScript: STRIKE_STUB,
      launch: launcher2.launch,
      connect: broken.connect,
    });
    expect(failed.ok).toBe(false);
    expect(failed.pages).toHaveLength(2);
    expect(failed.pages[0]).toMatchObject({
      count: -1,
      error: 'navigation failed: net::ERR_CONNECTION_REFUSED',
    });
    expect(launcher2.calls.closed).toBe(1);
  });

  it('closes Chrome when the connection fails', async () => {
    const launcher = fakeLauncher();
    await expect(
      auditOverrides({
        urls: ['http://a.test/'],
        widths: [800],
        states: ['default'],
        chromePath: process.execPath,
        strikeScript: STRIKE_STUB,
        launch: launcher.launch,
        connect: async () => {
          throw new HypDrivError('E_UPSTREAM', 'refused');
        },
      }),
    ).rejects.toMatchObject({ code: 'E_UPSTREAM' });
    expect(launcher.calls.closed).toBe(1);
  });
});

describe('wrapStrikeScript', () => {
  it('installs the script and returns the report as JSON', () => {
    const json = vm.runInNewContext(wrapStrikeScript(STRIKE_STUB), {}) as string;
    expect(JSON.parse(json)).toEqual({ struck: [], count: 0, rules: 7, skipped: [] });
    expect(vm.runInNewContext(wrapStrikeScript('var nothing = 1;'), {})).toBe('null');
  });
});
