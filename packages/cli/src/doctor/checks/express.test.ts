import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, tempProject } from '../../__tests__/helpers';
import { detectProject } from '../../project';
import { findCheck } from '../registry';
import type { CheckContext } from '../types';
import { expressChecks, expressRegistration, usesHttpServerHandler } from './express';

afterEach(cleanupProjects);

describe('expressRegistration', () => {
  it('accepts the middleware before routes, routers and static files', () => {
    const src = [
      'const app = express();',
      'app.use(compression());',
      'useHypDriv(app, { config });',
      "app.use(express.static('public'));",
      "app.use('/api', api);",
      "app.get('/', h);",
    ].join('\n');
    expect(expressRegistration(src)).toEqual({ answersBefore: null, compressionAfter: false });
    expect(expressRegistration("app.use(hypdriv({ config }));\napp.post('/x', h);")).toEqual({
      answersBefore: null,
      compressionAfter: false,
    });
  });

  it('names the first thing that answers before it', () => {
    expect(expressRegistration("app.get('/health', h);\nuseHypDriv(app, { config });")?.answersBefore).toBe(
      '.get()',
    );
    expect(
      expressRegistration("app.use(express.static('public'));\napp.use(hypdriv({ config }));")?.answersBefore,
    ).toBe('express.static()');
    expect(expressRegistration("app.use('/api', api);\nuseHypDriv(app, { config });")?.answersBefore).toBe(
      ".use('/path', …)",
    );
    expect(expressRegistration("app.route('/books').get(h);\nuseHypDriv(app);")?.answersBefore).toBe(
      '.route()',
    );
  });

  it('flags compression() after it and ignores other apps, comments and strings', () => {
    expect(
      expressRegistration('useHypDriv(app, { config });\napp.use(compression());')?.compressionAfter,
    ).toBe(true);
    const other = "api.get('/x', h);\nconst app = express();\nuseHypDriv(app, { config });";
    expect(expressRegistration(other)).toEqual({ answersBefore: null, compressionAfter: false });
    const commented = "// app.get('/old', h);\nconst s = \"app.get('/x')\";\nuseHypDriv(app, { config });";
    expect(expressRegistration(commented)).toEqual({ answersBefore: null, compressionAfter: false });
    expect(expressRegistration("app.get('/', h);")).toBeNull();
    // A regular expression with quotes (the example's escapeHtml) does not hide the registration.
    const escaped = `const escapeHtml = (v) => v.replace(/[&<>"']/g, (c) => \`&#\${c.charCodeAt(0)};\`);\nconst app = express();\nuseHypDriv(app, { config });\napp.get('/', h);`;
    expect(expressRegistration(escaped)).toEqual({ answersBefore: null, compressionAfter: false });
  });
});

describe('usesHttpServerHandler', () => {
  it('recognises the cloudflare:node HTTP server entry', () => {
    expect(
      usesHttpServerHandler(
        "import { httpServerHandler } from 'cloudflare:node';\napp.listen(8080);\nexport default httpServerHandler({ port: 8080 });",
      ),
    ).toBe(true);
    expect(usesHttpServerHandler('export default { fetch() {} };')).toBe(false);
  });
});

function context(dir: string, platform: 'node' | 'vercel' | 'cloudflare' = 'node'): CheckContext {
  const project = detectProject(dir, { env: {} });
  return { root: dir, project: { ...project, platform } } as unknown as CheckContext;
}

const run = async (id: string, ctx: CheckContext) => {
  const check = expressChecks.find((c) => c.id === id);
  if (!check) throw new Error(id);
  return check.run(ctx);
};

describe('express checks', () => {
  const base = {
    'package.json': JSON.stringify({ name: 'api', type: 'module', dependencies: { express: '^5.2.1' } }),
    ...installed('express', '5.3.0'),
    ...installed('@hypdriv/express', '0.1.0'),
  };

  it('passes the example layout on every platform', async () => {
    const p = tempProject({
      ...base,
      'src/app.ts':
        "import express from 'express';\nimport { useHypDriv } from '@hypdriv/express';\nimport config from '../hypdriv.config.js';\nconst app = express();\nuseHypDriv(app, { config });\napp.get('/', h);\nexport default app;\n",
      'src/worker.ts':
        "import { httpServerHandler } from 'cloudflare:node';\nimport app from './app.js';\napp.listen(8080);\nexport default httpServerHandler({ port: 8080 });\n",
      'wrangler.jsonc':
        '{ "name": "api", "main": "src/worker.ts", "compatibility_flags": ["nodejs_compat"] }',
    });
    for (const id of ['express.integration', 'express.version', 'express.registered', 'express.order'])
      expect((await run(id, context(p.dir))).status, id).toBe('pass');
    expect((await run('express.vercel-entry', context(p.dir, 'vercel'))).status).toBe('pass');
    expect((await run('express.workers-entry', context(p.dir, 'cloudflare'))).status).toBe('pass');
  });

  it('fails Express 4, a late registration and an entry Vercel cannot load', async () => {
    const p = tempProject({
      ...base,
      ...installed('express', '4.21.2'),
      'src/app.ts':
        "import express from 'express';\nimport { useHypDriv } from '@hypdriv/express';\nimport config from '../hypdriv.config';\nconst app = express();\napp.get('/health', h);\nuseHypDriv(app, { config });\nexport default app;\n",
    });
    expect((await run('express.version', context(p.dir))).status).toBe('fail');
    const order = await run('express.order', context(p.dir));
    expect(order.status).toBe('fail');
    expect(order.message).toContain('.get()');
    const vercel = await run('express.vercel-entry', context(p.dir, 'vercel'));
    expect(vercel.status).toBe('fail');
    expect(vercel.message).toContain("'../hypdriv.config'");
  });

  it('does not ask an Express app for a build manifest it never has', async () => {
    const p = tempProject({ ...base, 'src/app.ts': "import express from 'express';\n" });
    const result = await findCheck('hypdriv.manifest')!.run(context(p.dir));
    expect(result).toMatchObject({ status: 'pass', informational: true });
    expect(result.message).toContain('no build step');
  });

  it('fails a Worker entry without the HTTP server handler or nodejs_compat', async () => {
    const p = tempProject({
      ...base,
      'src/app.ts': "import express from 'express';\nimport { useHypDriv } from '@hypdriv/express';\n",
      'src/worker.ts': 'export default { fetch() { return new Response(); } };\n',
      'wrangler.jsonc':
        '{ "name": "api", "main": "src/worker.ts", "compatibility_flags": ["nodejs_compat"] }',
    });
    expect((await run('express.workers-entry', context(p.dir, 'cloudflare'))).status).toBe('fail');
    p.write('wrangler.jsonc', '{ "name": "api", "main": "src/worker.ts" }');
    const flags = await run('express.workers-entry', context(p.dir, 'cloudflare'));
    expect(flags.status).toBe('fail');
    expect(flags.message).toContain('nodejs_compat');
  });
});
