import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, memoryIO, tempProject } from '../../__tests__/helpers';
import { runCommand } from '../../main';
import type { CheckReport } from '../types';
import { adapterWiring, entryWiring, isQwikV1, qwikVersionSupported, vercelOutDir } from './qwik';

afterEach(cleanupProjects);

describe('qwikVersionSupported', () => {
  it('accepts 2.0.0-rc.4 and later 2.x releases', () => {
    for (const version of ['2.0.0-rc.4', '2.0.0-rc.12', '2.0.0', '2.0.1-beta.1', '2.3.0'])
      expect(qwikVersionSupported(version), version).toBe(true);
  });

  it('rejects earlier pre-releases and other majors', () => {
    for (const version of ['2.0.0-rc.3', '2.0.0-beta.9', '2.0.0-alpha.1', '1.20.3', '3.0.0'])
      expect(qwikVersionSupported(version), version).toBe(false);
  });

  it('does not judge a version it cannot read', () => {
    expect(qwikVersionSupported('latest')).toBe(true);
    expect(isQwikV1('1.20.3')).toBe(true);
    expect(isQwikV1('2.0.0-rc.4')).toBe(false);
  });
});

describe('adapterWiring', () => {
  it('tells Hypdriv’s adapters from Qwik’s own', () => {
    expect(adapterWiring("import { nodeAdapter } from '@hypdriv/qwik/adapters/node';")).toBe('hypdriv');
    expect(adapterWiring("import { vercelAdapter } from '@hypdriv/qwik/adapters/vercel';")).toBe('hypdriv');
    expect(
      adapterWiring("import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';"),
    ).toBe('qwik');
    expect(
      adapterWiring("import { vercelEdgeAdapter } from '@builder.io/qwik-city/adapters/vercel-edge/vite';"),
    ).toBe('qwik');
    expect(adapterWiring('export default {};')).toBe('none');
  });

  it('ignores commented imports', () => {
    expect(
      adapterWiring(
        "// import { nodeAdapter } from '@hypdriv/qwik/adapters/node';\n/* import x from '@hypdriv/qwik/adapters/vercel'; */\nexport default {};",
      ),
    ).toBe('none');
  });
});

describe('entryWiring', () => {
  it('tells Hypdriv’s router from Qwik’s own', () => {
    expect(entryWiring("import { createQwikRouter } from '@hypdriv/qwik/middleware/node';")).toBe('hypdriv');
    expect(entryWiring("import { createQwikRouter } from '@hypdriv/qwik/middleware/cloudflare';")).toBe(
      'hypdriv',
    );
    expect(
      entryWiring("import { createQwikRouter } from '@qwik.dev/router/middleware/cloudflare-pages';"),
    ).toBe('qwik');
    expect(entryWiring("import { createQwikRouter } from '@qwik.dev/router/middleware/node';")).toBe('qwik');
    expect(entryWiring('export default {};')).toBe('none');
  });
});

describe('vercelOutDir', () => {
  it('requires the server build to go into the Build Output function directory', () => {
    expect(vercelOutDir("build: { outDir: '.vercel/output/functions/_qwik-router.func' }")).toBe(true);
    expect(vercelOutDir('build: { outDir: ".vercel/output/functions/qwik.func" }')).toBe(true);
    expect(vercelOutDir("build: { outDir: 'server' }")).toBe(false);
    expect(vercelOutDir('build: { ssr: true }')).toBe(false);
  });
});

describe('Qwik doctor checks', () => {
  async function doctor(files: Record<string, string>, only: string[], args: string[] = []) {
    const p = tempProject(files);
    const io = memoryIO(p.dir);
    const code = await runCommand('doctor', ['--json', ...args, ...only.flatMap((id) => ['--only', id])], io);
    const out = JSON.parse(io.out) as { checks: CheckReport[] };
    return { p, code, byId: Object.fromEntries(out.checks.map((c) => [c.id, c])) };
  }

  const project = (extra: Record<string, string> = {}, version = '2.0.0-rc.4') => ({
    'package.json': JSON.stringify({
      name: 'qk',
      devDependencies: { '@qwik.dev/core': version, '@qwik.dev/router': version, vite: '^8.3.5' },
    }),
    ...installed('@qwik.dev/core', version),
    ...installed('@qwik.dev/router', version),
    ...installed('vite', '8.3.5'),
    'vite.config.ts': "import { hypdriv } from '@hypdriv/qwik';\nexport default { plugins: [hypdriv()] };\n",
    ...extra,
  });

  it('qwik.version: supports the v2 release candidates, names the v1 migration', async () => {
    expect((await doctor(project(), ['qwik.version'])).byId['qwik.version']).toMatchObject({
      status: 'pass',
    });

    const old = (await doctor(project({}, '2.0.0-rc.3'), ['qwik.version'])).byId['qwik.version'];
    expect(old).toMatchObject({ status: 'fail' });
    expect(old?.message).toContain('>=2.0.0-rc.4');

    const v1 = (
      await doctor(
        {
          'package.json': JSON.stringify({
            name: 'qk1',
            dependencies: { '@builder.io/qwik-city': '1.20.3' },
          }),
          ...installed('@builder.io/qwik-city', '1.20.3'),
          'vite.config.ts': 'export default {};\n',
        },
        ['qwik.version'],
      )
    ).byId['qwik.version'];
    expect(v1).toMatchObject({ status: 'fail' });
    expect(v1?.message).toContain('qwik migrate-v2');
  });

  it('qwik.vite: wants Vite 8', async () => {
    expect((await doctor(project(), ['qwik.vite'])).byId['qwik.vite']).toMatchObject({ status: 'pass' });
    const old = project({ ...installed('vite', '7.1.0') });
    expect((await doctor(old, ['qwik.vite'])).byId['qwik.vite']).toMatchObject({ status: 'warn' });
  });

  it('qwik.adapter: a Hypdriv adapter must build the server', async () => {
    const hypdriv = project({
      'adapters/node/vite.config.ts': "import { nodeAdapter } from '@hypdriv/qwik/adapters/node';\n",
    });
    expect((await doctor(hypdriv, ['qwik.adapter'])).byId['qwik.adapter']).toMatchObject({ status: 'pass' });

    const own = project({
      'adapters/node-server/vite.config.ts':
        "import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';\n",
    });
    const failed = (await doctor(own, ['qwik.adapter'])).byId['qwik.adapter'];
    expect(failed).toMatchObject({ status: 'fail' });
    expect(failed?.message).toContain("Qwik's own adapter");

    const mixed = project({
      'adapters/node/vite.config.ts': "import { nodeAdapter } from '@hypdriv/qwik/adapters/node';\n",
      'adapters/node-server/vite.config.ts':
        "import { nodeServerAdapter } from '@qwik.dev/router/adapters/node-server/vite';\n",
    });
    expect((await doctor(mixed, ['qwik.adapter'])).byId['qwik.adapter']).toMatchObject({
      status: 'pass',
      informational: true,
    });

    expect((await doctor(project(), ['qwik.adapter'])).byId['qwik.adapter']).toMatchObject({
      status: 'warn',
    });
  });

  it('qwik.entry: a platform entry must create the Hypdriv request handler', async () => {
    const ok = project({
      'src/entry.ssr.tsx': 'export default null;\n',
      'src/entry.node.tsx': "import { createQwikRouter } from '@hypdriv/qwik/middleware/node';\n",
    });
    // entry.ssr renders; it is not a platform entry.
    expect((await doctor(ok, ['qwik.entry'])).byId['qwik.entry']).toMatchObject({ status: 'pass' });

    const own = project({
      'src/entry.ssr.tsx': 'export default null;\n',
      'src/entry.node-server.tsx': "import { createQwikRouter } from '@qwik.dev/router/middleware/node';\n",
    });
    const failed = (await doctor(own, ['qwik.entry'])).byId['qwik.entry'];
    expect(failed).toMatchObject({ status: 'fail' });
    expect(failed?.message).toContain('entry.node-server.tsx');

    const none = (await doctor(project({ 'src/entry.ssr.tsx': 'x\n' }), ['qwik.entry'])).byId['qwik.entry'];
    expect(none).toMatchObject({ status: 'fail' });
    expect(none?.message).toContain('No server entry');
  });

  it('qwik.worker: the Worker is the adapter’s dist/_worker.js and the assets are dist', async () => {
    const wrangler = (o: Record<string, unknown>) => ({
      'wrangler.jsonc': JSON.stringify({ name: 'qk', ...o }),
    });
    const good = project(
      wrangler({
        main: './dist/_worker.js',
        assets: {
          directory: './dist',
          binding: 'ASSETS',
          run_worker_first: ['/*', '!/build/*', '!/assets/*'],
        },
      }),
    );
    expect((await doctor(good, ['qwik.worker'])).byId['qwik.worker']).toMatchObject({ status: 'pass' });

    const everything = project(
      wrangler({
        main: './dist/_worker.js',
        assets: { directory: './dist', binding: 'ASSETS', run_worker_first: ['/*'] },
      }),
    );
    expect((await doctor(everything, ['qwik.worker'])).byId['qwik.worker']).toMatchObject({
      status: 'pass',
      informational: true,
    });

    const wrong = project(wrangler({ main: 'src/worker.ts', assets: { directory: './public' } }));
    const warned = (await doctor(wrong, ['qwik.worker'])).byId['qwik.worker'];
    expect(warned).toMatchObject({ status: 'warn' });
    expect(warned?.message).toContain('_worker.js');
    expect(warned?.message).toContain('"./dist"');
  });

  it('qwik.vercel-outdir: the Vercel adapter builds into the Build Output', async () => {
    const platform = ['--platform', 'vercel'];
    const missing = project({
      'adapters/vercel/vite.config.ts':
        "import { vercelAdapter } from '@hypdriv/qwik/adapters/vercel';\nexport default { build: { ssr: true } };\n",
    });
    const failed = (await doctor(missing, ['qwik.vercel-outdir'], platform)).byId['qwik.vercel-outdir'];
    expect(failed).toMatchObject({ status: 'fail' });
    expect(failed?.message).toContain('.vercel/output/functions/_qwik-router.func');

    const good = project({
      'adapters/vercel/vite.config.ts':
        "import { vercelAdapter } from '@hypdriv/qwik/adapters/vercel';\nexport default { build: { outDir: '.vercel/output/functions/_qwik-router.func' } };\n",
    });
    expect((await doctor(good, ['qwik.vercel-outdir'], platform)).byId['qwik.vercel-outdir']).toMatchObject({
      status: 'pass',
    });
  });

  it('qwik.loader-json: recommends running the pipeline for route loader data on Cloudflare', async () => {
    const wrangler = { 'wrangler.jsonc': JSON.stringify({ name: 'qk', main: './dist/_worker.js' }) };
    const quiet = (await doctor(project(wrangler), ['qwik.loader-json'])).byId['qwik.loader-json'];
    expect(quiet).toMatchObject({ status: 'pass', informational: true });
    expect(quiet?.message).toContain('skipStaticAssets: false');

    const configured = project({
      ...wrangler,
      'hypdriv.config.ts':
        "export default { site: { name: 'qk' }, cloudflare: { skipStaticAssets: false } };\n",
    });
    const done = (await doctor(configured, ['qwik.loader-json'])).byId['qwik.loader-json'];
    expect(done).toMatchObject({ status: 'pass' });
    expect(done?.informational).toBeFalsy();
  });

  it('vite.durable-objects: follows the generated Worker stub to the server bundle', async () => {
    const wrangler = JSON.stringify({
      name: 'qk',
      main: './dist/_worker.js',
      durable_objects: {
        bindings: [
          { name: 'HYPDRIV_LIMITER', class_name: 'HypDrivLimiter' },
          { name: 'HYPDRIV_INDEX', class_name: 'HypDrivIndex' },
        ],
      },
    });
    const stub =
      '// Generated by @hypdriv/qwik\nexport * from "../server/entry.cloudflare.js";\nexport { default } from "../server/entry.cloudflare.js";\n';
    const exported = project({
      'wrangler.jsonc': wrangler,
      'dist/_worker.js': stub,
      'server/entry.cloudflare.js':
        'class a{}class b{}export{a as HypDrivLimiter,b as HypDrivIndex,a as default};\n',
    });
    expect((await doctor(exported, ['vite.durable-objects'])).byId['vite.durable-objects']).toMatchObject({
      status: 'pass',
    });
    const missing = project({
      'wrangler.jsonc': wrangler,
      'dist/_worker.js': stub,
      'server/entry.cloudflare.js': 'export default {};\n',
    });
    expect((await doctor(missing, ['vite.durable-objects'])).byId['vite.durable-objects']).toMatchObject({
      status: 'fail',
    });
  });

  it('vite.durable-objects: only an export counts, not a mention of the classes or of the module', async () => {
    const wrangler = JSON.stringify({
      name: 'qk',
      main: './src/worker.ts',
      durable_objects: {
        bindings: [
          { name: 'HYPDRIV_LIMITER', class_name: 'HypDrivLimiter' },
          { name: 'HYPDRIV_INDEX', class_name: 'HypDrivIndex' },
        ],
      },
    });
    const status = async (worker: string) =>
      (
        await doctor(project({ 'wrangler.jsonc': wrangler, 'src/worker.ts': worker }), [
          'vite.durable-objects',
        ])
      ).byId['vite.durable-objects']?.status;

    expect(
      await status(
        "// TODO: export { HypDrivLimiter, HypDrivIndex } from '@hypdriv/cloudflare/durable-objects'\nexport default {};\n",
      ),
    ).toBe('fail');
    expect(
      await status(
        "import { HypDrivLimiter, HypDrivIndex } from '@hypdriv/cloudflare/durable-objects';\nconst names = ['HypDrivLimiter', 'HypDrivIndex'];\nexport default {};\n",
      ),
    ).toBe('fail');
    // Only one of the two classes is exported.
    expect(await status("export { HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';\n")).toBe(
      'fail',
    );

    expect(
      await status(
        "export {\n  HypDrivIndex,\n  HypDrivLimiter,\n} from '@hypdriv/cloudflare/durable-objects';\n",
      ),
    ).toBe('pass');
    expect(await status("export * from '@hypdriv/cloudflare/durable-objects';\n")).toBe('pass');
    expect(
      await status(
        "import { A, B } from './mine';\nexport { A as HypDrivLimiter, B as HypDrivIndex };\nexport default {};\n",
      ),
    ).toBe('pass');
    expect(
      await status('export class HypDrivLimiter {}\nexport class HypDrivIndex {}\nexport default {};\n'),
    ).toBe('pass');
  });

  it('applies to Qwik projects only', async () => {
    const next = {
      'package.json': JSON.stringify({ name: 'site', dependencies: { next: '16.4.3' } }),
      ...installed('next', '16.4.3'),
    };
    const { byId } = await doctor(next, ['qwik.version', 'qwik.adapter', 'qwik.entry']);
    for (const id of ['qwik.version', 'qwik.adapter', 'qwik.entry'])
      expect(byId[id]?.status, id).toBe('skip');
  });
});
