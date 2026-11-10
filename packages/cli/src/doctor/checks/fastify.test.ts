import { afterEach, describe, expect, it } from 'vitest';
import { cleanupProjects, installed, tempProject } from '../../__tests__/helpers';
import { detectProject } from '../../project';
import type { CheckContext } from '../types';
import { fastifyChecks, fastifyRegistration } from './fastify';
import { awaitsListenAtTopLevel, extensionlessImports } from './server-entry';

afterEach(cleanupProjects);

describe('fastifyRegistration', () => {
  it('accepts @fastify/compress after the plugin and flags it before', () => {
    const after =
      "import fastifyCompress from '@fastify/compress';\napp.register(hypdriv, { config });\napp.register(fastifyCompress);";
    expect(fastifyRegistration(after)).toEqual({ compressBefore: null });
    const before =
      "import compress from '@fastify/compress';\nawait app.register(compress);\nawait app.register(hypdriv, { config });";
    expect(fastifyRegistration(before)).toEqual({ compressBefore: 'compress' });
    const required =
      "const compress = require('@fastify/compress');\napp.register(compress);\napp.register(hypdriv, { config });";
    expect(fastifyRegistration(required)).toEqual({ compressBefore: 'compress' });
  });

  it('returns null without the plugin and ignores comments', () => {
    expect(fastifyRegistration('app.register(routes);')).toBeNull();
    expect(fastifyRegistration('// app.register(hypdriv)\napp.register(routes);')).toBeNull();
  });
});

describe('server entry helpers', () => {
  it('finds relative imports without an extension', () => {
    const source = [
      "import config from '../hypdriv.config';",
      "import { routes } from './routes.js';",
      "import data from './data.json' with { type: 'json' };",
      "import Fastify from 'fastify';",
      "const lazy = await import('./lazy');",
      "// import old from './old';",
    ].join('\n');
    expect(extensionlessImports(source)).toEqual(['../hypdriv.config', './lazy']);
  });

  it('tells a top-level await of listen() from one inside a function', () => {
    expect(awaitsListenAtTopLevel('const app = Fastify();\nawait app.listen({ port: 3000 });')).toBe(true);
    expect(awaitsListenAtTopLevel('app.listen({ port }).then(log);')).toBe(false);
    expect(
      awaitsListenAtTopLevel('async function start() {\n  await app.listen({ port: 3000 });\n}\nstart();'),
    ).toBe(false);
  });
});

function context(dir: string, platform: 'node' | 'vercel' | 'cloudflare' = 'node'): CheckContext {
  const project = detectProject(dir, { env: {} });
  return { root: dir, project: { ...project, platform } } as unknown as CheckContext;
}

const run = async (id: string, ctx: CheckContext) => {
  const check = fastifyChecks.find((c) => c.id === id);
  if (!check) throw new Error(id);
  return check.run(ctx);
};

describe('fastify checks', () => {
  const base = {
    'package.json': JSON.stringify({ name: 'api', type: 'module', dependencies: { fastify: '^5.8.0' } }),
    ...installed('fastify', '5.12.7'),
    ...installed('@hypdriv/fastify', '0.1.0'),
  };

  it('passes the example layout on Node and Vercel and refuses Workers', async () => {
    const p = tempProject({
      ...base,
      'src/server.ts':
        "import fastifyCompress from '@fastify/compress';\nimport { hypdriv } from '@hypdriv/fastify';\nimport Fastify from 'fastify';\nimport { routes } from './routes.js';\nconst app = Fastify();\napp.register(hypdriv, { config });\napp.register(fastifyCompress);\napp.register(routes);\napp.listen({ port: 3000 }).then(log);\n",
    });
    for (const id of ['fastify.integration', 'fastify.version', 'fastify.registered', 'fastify.order'])
      expect((await run(id, context(p.dir))).status, id).toBe('pass');
    expect((await run('fastify.vercel-entry', context(p.dir, 'vercel'))).status).toBe('pass');
    expect((await run('fastify.workers', context(p.dir, 'cloudflare'))).status).toBe('fail');
  });

  it('fails Fastify 4, compression ahead of the plugin and a Vercel entry that awaits listen()', async () => {
    const p = tempProject({
      ...base,
      ...installed('fastify', '4.29.1'),
      'src/server.ts':
        "import compress from '@fastify/compress';\nimport { hypdriv } from '@hypdriv/fastify';\nimport Fastify from 'fastify';\nconst app = Fastify();\nawait app.register(compress);\nawait app.register(hypdriv, { config });\nawait app.listen({ port: 3000 });\n",
    });
    expect((await run('fastify.version', context(p.dir))).status).toBe('fail');
    expect((await run('fastify.order', context(p.dir))).status).toBe('fail');
    const vercel = await run('fastify.vercel-entry', context(p.dir, 'vercel'));
    expect(vercel.status).toBe('fail');
    expect(vercel.message).toContain('awaits listen()');
  });

  it('fails a Vercel entry that never starts a server', async () => {
    const p = tempProject({
      ...base,
      'src/app.ts':
        "import Fastify from 'fastify';\nimport { hypdriv } from '@hypdriv/fastify';\nconst app = Fastify();\napp.register(hypdriv, { config });\nexport default app;\n",
    });
    const vercel = await run('fastify.vercel-entry', context(p.dir, 'vercel'));
    expect(vercel.status).toBe('fail');
    expect(vercel.message).toContain('listen()');
  });
});
