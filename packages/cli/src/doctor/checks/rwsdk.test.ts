import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, memoryIO, tempProject } from '../../__tests__/helpers';
import { runCommand } from '../../main';
import type { CheckReport } from '../types';
import {
  findMiddleware,
  rwsdkCloudflarePlugin,
  rwsdkPluginOrder,
  rwsdkVersionSupported,
  rwsdkWorkerEntry,
  rwsdkWorkerWiring,
} from './rwsdk';

afterEach(cleanupProjects);

describe('rwsdkWorkerWiring', () => {
  it('recognises the wrapper and the nonce middleware', () => {
    const source = `import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
export default withHypDriv(defineApp([hypdrivMiddleware(), route('/', Home)]));`;
    expect(rwsdkWorkerWiring(source)).toEqual({ wrapped: true, middleware: true });
  });

  it('reports a wrapper without the middleware and an unwrapped app', () => {
    expect(
      rwsdkWorkerWiring(
        "import { withHypDriv } from '@hypdriv/rwsdk/worker';\nexport default withHypDriv(defineApp([]));",
      ),
    ).toEqual({ wrapped: true, middleware: false });
    expect(rwsdkWorkerWiring('export default defineApp([route("/", Home)]);')).toEqual({
      wrapped: false,
      middleware: false,
    });
    // withHypDriv() of another package is not ours.
    expect(rwsdkWorkerWiring("import { withHypDriv } from '@hypdriv/waku';\nwithHypDriv({})")).toMatchObject({
      wrapped: false,
    });
  });
});

describe('rwsdkWorkerEntry', () => {
  it('prefers the Wrangler main and falls back to src/worker.*', () => {
    const p = tempProject({ 'src/worker.tsx': 'default', 'src/server.tsx': 'custom' });
    expect(rwsdkWorkerEntry(p.dir, 'src/server.tsx', p.dir)?.source).toBe('custom');
    expect(rwsdkWorkerEntry(p.dir, undefined, p.dir)?.source).toBe('default');
    expect(rwsdkWorkerEntry(p.dir, 'src/missing.tsx', p.dir)?.source).toBe('default');
    expect(rwsdkWorkerEntry(tempProject().dir, undefined, p.dir)).toBeNull();
  });
});

describe('findMiddleware', () => {
  it('finds the middleware in a file of src, not in node_modules or hidden folders', () => {
    const p = tempProject({
      'src/worker.tsx': 'export default 1;',
      'src/app/routes.tsx': 'export const routes = [hypdrivMiddleware()];',
      'src/node_modules/x/index.js': 'hypdrivMiddleware()',
    });
    expect(findMiddleware(p.dir)).toMatch(/src[\\/]app[\\/]routes\.tsx$/);
    expect(findMiddleware(tempProject({ 'src/.hidden/a.ts': 'hypdrivMiddleware()' }).dir)).toBeNull();
    expect(findMiddleware(tempProject().dir)).toBeNull();
  });
});

describe('rwsdkCloudflarePlugin', () => {
  const declared = (environment: string, ssr = true) => `import { cloudflare } from '@cloudflare/vite-plugin';
export default defineConfig({
  ${ssr ? 'environments: { ssr: {} },' : ''}
  plugins: [cloudflare({ viteEnvironment: { name: '${environment}' } }), redwood(), hypdriv()],
});`;

  it('accepts the plugin on the worker environment with the ssr environment declared', () => {
    expect(rwsdkCloudflarePlugin(declared('worker'))).toBe('ok');
  });

  it('flags another environment and a missing ssr environment', () => {
    expect(rwsdkCloudflarePlugin(declared('ssr'))).toBe('environment');
    expect(rwsdkCloudflarePlugin(declared('worker', false))).toBe('ssr-environment');
  });

  it('leaves the plugin to RedwoodSDK when the config does not declare it', () => {
    expect(rwsdkCloudflarePlugin('export default defineConfig({ plugins: [redwood(), hypdriv()] });')).toBe(
      'implicit',
    );
    expect(rwsdkCloudflarePlugin("import { cloudflare } from '@cloudflare/vite-plugin';")).toBe('implicit');
  });
});

describe('rwsdkPluginOrder', () => {
  it('wants hypdriv() after redwood()', () => {
    expect(rwsdkPluginOrder('plugins: [redwood(), hypdriv()]')).toBe('ok');
    expect(rwsdkPluginOrder('plugins: [hypdriv(), redwood()]')).toBe('before');
    expect(rwsdkPluginOrder('plugins: [redwood()]')).toBe('unknown');
  });
});

describe('rwsdkVersionSupported', () => {
  it('accepts 1.x releases', () => {
    for (const version of ['1.0.0', '1.7.5', '1.12.0-beta.1', '1.0.1-rc.2'])
      expect(rwsdkVersionSupported(version), version).toBe(true);
  });

  it('rejects 1.0.0 pre-releases and other majors', () => {
    for (const version of ['1.0.0-alpha.3', '1.0.0-beta.9', '0.3.1', '2.0.0'])
      expect(rwsdkVersionSupported(version), version).toBe(false);
  });

  it('does not judge a version it cannot read', () => {
    expect(rwsdkVersionSupported('latest')).toBe(true);
  });
});

describe('hypdriv doctor in a RedwoodSDK project', () => {
  const WRANGLER = `{
  "name": "rw",
  "main": "src/worker.tsx",
  "compatibility_date": "2026-10-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "binding": "ASSETS", "run_worker_first": ["/*", "!/assets/*"] },
  "durable_objects": { "bindings": [{ "name": "HYPDRIV_LIMITER", "class_name": "HypDrivLimiter" }] }
}`;
  const VITE = `import { cloudflare } from '@cloudflare/vite-plugin';
import { hypdriv } from '@hypdriv/rwsdk';
import { redwood } from 'rwsdk/vite';
export default defineConfig({
  environments: { ssr: {} },
  plugins: [cloudflare({ viteEnvironment: { name: 'worker' } }), redwood(), hypdriv()],
});`;
  const WORKER = `import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
export default withHypDriv(defineApp([hypdrivMiddleware(), route('/', Home)]));`;

  const doctor = async (files: Record<string, string>) => {
    const p = tempProject({
      'package.json': JSON.stringify({
        name: 'rw',
        dependencies: { rwsdk: '1.7.5', '@hypdriv/rwsdk': '0.1.0' },
        devDependencies: { vite: '^8.3.5' },
      }),
      ...installed('rwsdk', '1.7.5'),
      ...installed('@hypdriv/rwsdk', '0.1.0'),
      'hypdriv.config.ts': "export default { site: { name: 'rw' } };\n",
      'wrangler.jsonc': WRANGLER,
      'vite.config.mts': VITE,
      'src/worker.tsx': WORKER,
      ...files,
    });
    const io = memoryIO(p.dir, { env: {} });
    const code = await runCommand('doctor', ['--json'], io);
    const out = JSON.parse(io.out) as { checks: CheckReport[]; project: { framework?: { name?: string } } };
    return { code, byId: Object.fromEntries(out.checks.map((c) => [c.id, c])), out };
  };

  it('passes a complete project and exports the Durable Objects without an export of its own', async () => {
    const { byId } = await doctor({});
    for (const id of [
      'rwsdk.worker-entry',
      'rwsdk.nonce-middleware',
      'rwsdk.cloudflare-plugin',
      'rwsdk.plugin-order',
      'rwsdk.platform',
      'rwsdk.version',
      'vite.integration',
      'vite.registered',
      'vite.durable-objects',
    ])
      expect(byId[id]?.status, `${id}: ${byId[id]?.message}`).toBe('pass');
    expect(byId['vite.durable-objects']?.message).toContain('@hypdriv/rwsdk Vite plugin exports the classes');
  });

  it('fails a Worker that is not wrapped and one that lacks the nonce middleware', async () => {
    const unwrapped = await doctor({ 'src/worker.tsx': 'export default defineApp([route("/", Home)]);\n' });
    expect(unwrapped.byId['rwsdk.worker-entry']?.status).toBe('fail');
    expect(unwrapped.byId['rwsdk.worker-entry']?.message).toContain('withHypDriv()');

    const noMiddleware = await doctor({
      'src/worker.tsx':
        "import { withHypDriv } from '@hypdriv/rwsdk/worker';\nexport default withHypDriv(defineApp([route('/', Home)]));\n",
    });
    expect(noMiddleware.byId['rwsdk.nonce-middleware']?.status).toBe('fail');
    expect(noMiddleware.byId['rwsdk.nonce-middleware']?.message).toContain('hypdrivMiddleware()');
    expect(noMiddleware.byId['rwsdk.worker-entry']?.status).toBe('pass');
  });

  it('accepts the middleware in another file and skips the check when CSP is off', async () => {
    const elsewhere = await doctor({
      'src/worker.tsx':
        "import { withHypDriv } from '@hypdriv/rwsdk/worker';\nimport { routes } from './routes';\nexport default withHypDriv(defineApp(routes));\n",
      'src/routes.tsx': 'export const routes = [hypdrivMiddleware()];\n',
    });
    expect(elsewhere.byId['rwsdk.nonce-middleware']?.status).toBe('pass');
    expect(elsewhere.byId['rwsdk.nonce-middleware']?.message).toContain('routes.tsx');

    const off = await doctor({
      'hypdriv.config.ts': "export default { site: { name: 'rw' }, security: { csp: { mode: 'off' } } };\n",
      'src/worker.tsx':
        "import { withHypDriv } from '@hypdriv/rwsdk/worker';\nexport default withHypDriv(defineApp([]));\n",
    });
    expect(off.byId['rwsdk.nonce-middleware']?.status).toBe('skip');
  });

  it('fails a declared Cloudflare plugin on the wrong environment and warns about the plugin order', async () => {
    const wrong = await doctor({
      'vite.config.mts': VITE.replace("name: 'worker'", "name: 'ssr'"),
    });
    expect(wrong.byId['rwsdk.cloudflare-plugin']?.status).toBe('fail');

    const order = await doctor({
      'vite.config.mts': VITE.replace('redwood(), hypdriv()', 'hypdriv(), redwood()'),
    });
    expect(order.byId['rwsdk.plugin-order']?.status).toBe('warn');
  });

  it('reports a config that does not register the integration', async () => {
    const { byId } = await doctor({
      'vite.config.mts': 'export default defineConfig({ plugins: [redwood()] });\n',
    });
    expect(byId['vite.registered']?.status).toBe('fail');
    expect(byId['vite.registered']?.message).toContain('@hypdriv/rwsdk');
  });

  it('wants the classes exported by hand when the plugin is told not to', async () => {
    const { byId } = await doctor({
      'vite.config.mts': VITE.replace('hypdriv()', 'hypdriv({ durableObjects: false })'),
    });
    expect(byId['vite.durable-objects']?.status).toBe('fail');
  });
});
