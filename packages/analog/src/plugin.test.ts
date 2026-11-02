import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hypdriv } from './plugin';
import { resetViteState, viteState } from './state';

beforeEach(() => resetViteState());
afterEach(() => resetViteState());

type PluginHook<T> = (this: unknown, ...args: never[]) => T;
const hook = <T>(fn: unknown): PluginHook<T> => fn as PluginHook<T>;

describe('the Hypdriv Vite plugin', () => {
  it('turns on the client build manifest', () => {
    const plugin = hypdriv() as Plugin;
    expect(plugin.name).toBe('hypdriv:analog');
    const config = hook<{ environments: { client: { build: { manifest: boolean } } } }>(plugin.config).call(
      {},
    );
    expect(config.environments.client.build.manifest).toBe(true);
  });

  it('records the client output layout for the Nitro module', () => {
    const plugin = hypdriv() as Plugin;
    hook<void>(plugin.configResolved).call({}, {
      root: '/work/app',
      base: '/',
      environments: { client: { build: { manifest: true, assetsDir: 'assets', outDir: 'dist/client' } } },
    } as never);
    expect(viteState()).toMatchObject({
      root: '/work/app',
      base: '/',
      assetsDir: 'assets',
      manifest: true,
    });
    expect(viteState().clientOutDir).toMatch(/work[\\/]app[\\/]dist[\\/]client$/);
  });

  describe('in the dev server', () => {
    let server: Server | undefined;
    let root: string | undefined;
    afterEach(async () => {
      await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
      server = undefined;
      if (root) rmSync(root, { recursive: true, force: true });
      root = undefined;
    });

    async function devServer(options: Parameters<typeof hypdriv>[0] = {}) {
      root = mkdtempSync(join(tmpdir(), 'hypdriv-analog-dev-'));
      mkdirSync(join(root, 'src/app/pages'), { recursive: true });
      writeFileSync(join(root, 'src/app/pages/index.page.ts'), '');
      const plugin = hypdriv({ config: { site: { name: 'analog-dev' } }, ...options }) as Plugin;
      hook<void>(plugin.configResolved).call({}, { root, base: '/', environments: {} } as never);
      const middlewares: Array<(req: unknown, res: unknown, next: (err?: unknown) => void) => void> = [];
      hook<void>(plugin.configureServer).call({}, {
        middlewares: { use: (fn: never) => middlewares.push(fn) },
      } as never);
      const listening = createServer((req, res) => {
        const [middleware] = middlewares;
        const fallThrough = () => {
          res.statusCode = 404;
          res.end('vite');
        };
        if (middleware) middleware(req, res, fallThrough);
        else fallThrough();
      });
      server = listening;
      await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done));
      return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    }

    it('answers /_hypdriv/health and hands everything else to Vite', async () => {
      const origin = await devServer();
      const health = await fetch(`${origin}/_hypdriv/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { service: string; framework: string; routes: number };
      expect(body.service).toBe('analog-dev');
      expect(body.framework).toContain('Analog');
      expect(body.routes).toBe(1);
      const page = await fetch(`${origin}/about`);
      expect(page.status).toBe(404);
      expect(await page.text()).toBe('vite');
    });

    it('can be switched off', async () => {
      const origin = await devServer({ dev: false });
      const health = await fetch(`${origin}/_hypdriv/health`);
      expect(await health.text()).toBe('vite');
    });
  });
});
