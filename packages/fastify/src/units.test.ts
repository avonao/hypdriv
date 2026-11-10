import { Readable } from 'node:stream';
import Fastify, { type FastifyReply } from 'fastify';
import { describe, expect, it } from 'vitest';
import { applyResponse, fastifyManifest, fastifyPattern, payloadResponse, routesFromTree } from './index';

describe('fastifyPattern()', () => {
  it.each([
    ['/', ['/']],
    ['/users', ['/users']],
    ['/users/:id', ['/users/[id]']],
    ['/orgs/:org/repos/:repo', ['/orgs/[org]/repos/[repo]']],
    ['/files/*', ['/files/[...splat]']],
    ['*', ['/[...splat]']],
    ['/a/*/b', ['/a/[splat]/b']],
    ['/docs/:page?', ['/docs/[page]', '/docs']],
    ['/:org?', ['/[org]', '/']],
    ['/n/:id(^\\d+)', ['/n/[id]']],
    ['/n/:id((a|b))/x', ['/n/[id]/x']],
    ['/range/:from-:to', ['/range/[from]']],
    ['/file.:ext', ['/[ext]']],
    ['/price/::fixed', ['/price/:fixed']],
    ['/rss.xml', ['/rss.xml']],
  ])('%s', (url, patterns) => {
    expect(fastifyPattern(url).sort()).toEqual([...patterns].sort());
  });

  it('reads a lone colon as text', () => {
    expect(fastifyPattern('/time/12:')).toEqual(['/time/12:']);
  });
});

describe('routesFromTree()', () => {
  it('reads every route URL back from the printed router tree', async () => {
    const app = Fastify();
    for (const url of [
      '/',
      '/early',
      '/users/:id',
      '/users/:id/posts/:post',
      '/files/*',
      '/opt/:a?',
      '/re/:id(^\\d+)',
      '/multi/:a-:b',
      '/api/items/:id',
      '/ünï/ç',
    ])
      app.get(url, async () => 'x');
    app.post('/api/items', async () => 'x');
    app.route({ method: ['GET', 'POST'], url: '/both', handler: async () => 'x' });
    await app.register(
      async (child) => {
        child.get('/inner/:x', async () => 'x');
        child.get('/', async () => 'x');
      },
      { prefix: '/plug' },
    );
    await app.ready();
    expect(routesFromTree(app.printRoutes()).sort()).toEqual(
      [
        '/',
        '/early',
        '/users/:id',
        '/users/:id/posts/:post',
        '/files/*',
        '/opt',
        '/opt/:a',
        '/re/:id(^\\d+)',
        '/multi/:a-:b',
        '/api/items',
        '/api/items/:id',
        '/ünï/ç',
        '/both',
        '/plug',
        '/plug/',
        '/plug/inner/:x',
      ].sort(),
    );
    await app.close();
  });

  it('reads nothing from an empty tree or text that is not one', () => {
    expect(routesFromTree('(empty tree)')).toEqual([]);
    expect(routesFromTree('')).toEqual([]);
    expect(routesFromTree('something else\n')).toEqual([]);
  });
});

describe('fastifyManifest()', () => {
  it('describes the app as dynamic Node endpoints under the fastify framework name', () => {
    const manifest = fastifyManifest(['/', '/users/:id', '/files/*', '/docs/:page?'], { version: '5.12.7' });
    expect(manifest.framework).toEqual({ name: 'fastify', version: '5.12.7' });
    expect(manifest.buildId).toBe('runtime');
    const byPath = new Map(manifest.routes.map((route) => [route.pathname, route]));
    expect([...byPath.keys()].sort()).toEqual(
      ['/', '/docs', '/docs/[page]', '/files/[...splat]', '/users/[id]'].sort(),
    );
    expect(byPath.get('/')).toMatchObject({
      kind: 'endpoint',
      runtime: 'nodejs',
      dynamic: false,
      id: 'endpoint:/',
    });
    expect(byPath.get('/users/[id]')).toMatchObject({ dynamic: true, id: 'endpoint:/users/[id]' });
    expect(new RegExp(byPath.get('/users/[id]')!.regex).test('/users/42')).toBe(true);
    expect(new RegExp(byPath.get('/users/[id]')!.regex).test('/users/42/more')).toBe(false);
  });

  it('adds the routes option in either syntax, without duplicates', () => {
    const manifest = fastifyManifest(['/users/:id'], {
      buildId: 'b1',
      routes: ['/legacy/:id', '/files/[...path]', 'bare', '/users/:id'],
    });
    expect(manifest.buildId).toBe('b1');
    expect(manifest.routes.map((route) => route.pathname).sort()).toEqual(
      ['/bare', '/files/[...path]', '/legacy/[id]', '/users/[id]'].sort(),
    );
  });

  it('gives an empty manifest for no routes', () => {
    expect(fastifyManifest([]).routes).toEqual([]);
  });
});

/** The parts of a reply the helpers use, over a real Fastify reply. */
async function withReply<T>(
  run: (reply: FastifyReply, finish: () => Promise<void>) => T | Promise<T>,
  method = 'GET',
): Promise<T> {
  const app = Fastify();
  let result!: T;
  app.route({
    method: method as 'GET',
    url: '/x',
    handler: async (_request, reply) => {
      result = await run(reply, async () => undefined);
      return reply.send('ok');
    },
  });
  await app.inject({ method: method as 'GET', url: '/x' });
  await app.close();
  return result;
}

describe('payloadResponse()', () => {
  it('turns a string into a Response with its length, status and headers', async () => {
    const response = await withReply((reply) => {
      reply
        .code(201)
        .header('x-a', '1')
        .header('set-cookie', ['a=1', 'b=2'])
        .header('connection', 'keep-alive');
      return payloadResponse(reply, 'GET', 'hello');
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-a')).toBe('1');
    expect(response.headers.get('content-length')).toBe('5');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(response.headers.get('connection')).toBeNull();
    expect(await response.text()).toBe('hello');
  });

  it('keeps a content-length the route set and sizes Buffers and typed arrays', async () => {
    const [kept, sized] = await withReply((reply) => {
      reply.header('content-length', '99');
      const first = payloadResponse(reply, 'GET', Buffer.from('abc'));
      reply.removeHeader('content-length');
      return [first, payloadResponse(reply, 'GET', new Uint8Array([1, 2, 3, 4]))] as const;
    });
    expect(kept.headers.get('content-length')).toBe('99');
    expect(sized.headers.get('content-length')).toBe('4');
  });

  it('wraps Node and Web streams', async () => {
    const [node, web] = await withReply((reply) => {
      const source = Readable.from(['from ', 'node']);
      return [
        payloadResponse(reply, 'GET', source),
        payloadResponse(reply, 'GET', new Response('from web').body),
      ] as const;
    });
    expect(node.headers.has('content-length')).toBe(false);
    expect(await node.text()).toBe('from node');
    expect(await web.text()).toBe('from web');
  });

  it('has no body for HEAD, 204, 205 and 304, but HEAD states the length', async () => {
    const head = await withReply((reply) => payloadResponse(reply, 'HEAD', 'twelve bytes'), 'HEAD');
    expect(head.body).toBeNull();
    expect(head.headers.get('content-length')).toBe('12');
    for (const status of [204, 205, 304]) {
      const response = await withReply((reply) => payloadResponse(reply.code(status), 'GET', ''));
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
      expect(response.headers.has('content-length')).toBe(false);
    }
  });

  it('gives no body for a null payload', async () => {
    const response = await withReply((reply) => payloadResponse(reply, 'GET', null));
    expect(response.body).toBeNull();
  });
});

describe('applyResponse()', () => {
  it('replaces the status and the headers, with set-cookie as separate fields', async () => {
    const seen = await withReply((reply) => {
      reply.header('x-old', 'gone').header('content-type', 'text/plain');
      const body = applyResponse(
        reply,
        new Response('body', {
          status: 418,
          statusText: 'Teapot',
          headers: [
            ['x-new', 'here'],
            ['set-cookie', 'a=1'],
            ['set-cookie', 'b=2'],
            ['transfer-encoding', 'chunked'],
          ],
        }),
        'GET',
      );
      return {
        body,
        status: reply.statusCode,
        headers: reply.getHeaders(),
        message: reply.raw.statusMessage,
      };
    });
    expect(seen.status).toBe(418);
    expect(seen.message).toBe('Teapot');
    expect(seen.headers['x-old']).toBeUndefined();
    expect(seen.headers['content-type']).toBe('text/plain;charset=UTF-8');
    expect(seen.headers['x-new']).toBe('here');
    expect(seen.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(seen.headers['transfer-encoding']).toBeUndefined();
    expect(seen.body).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of seen.body as Readable) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('body');
  });

  it('returns null for bodiless responses and an empty stream for HEAD', async () => {
    const none = await withReply((reply) => applyResponse(reply, new Response(null, { status: 204 }), 'GET'));
    expect(none).toBeNull();
    const notModified = await withReply((reply) =>
      applyResponse(reply, new Response(null, { status: 304 }), 'GET'),
    );
    expect(notModified).toBeNull();
    const head = await withReply((reply) => applyResponse(reply, new Response('ignored'), 'HEAD'), 'HEAD');
    expect(head).toBeInstanceOf(Readable);
    expect((head as Readable).readableLength).toBe(0);
  });
});
