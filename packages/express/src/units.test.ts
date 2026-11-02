import { mkdtempSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import compression from 'compression';
import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  checkOrder,
  expressFetch,
  expressManifest,
  expressPattern,
  expressRoutes,
  hypdriv,
  ResponseCapture,
} from './index';

const noop = () => undefined;
const options = { config: { site: { name: 'express-units' } }, target: 'node' as const, development: false };

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;
const fetchFrom = (handler: Handler, init?: RequestInit, url = 'http://app.test/') =>
  expressFetch(handler as never, new Request(url, init));

describe('expressPattern()', () => {
  it.each([
    ['/', ['/']],
    ['/users', ['/users']],
    ['/users/:id', ['/users/[id]']],
    ['/orgs/:org/repos/:repo', ['/orgs/[org]/repos/[repo]']],
    ['/files/*path', ['/files/[...path]']],
    ['/a/*mid/b', ['/a/[mid]/b']],
    ['/book{/:chapter}', ['/book', '/book/[chapter]']],
    ['/{*splat}', ['/', '/[...splat]']],
    ['/file.:ext', ['/[ext]']],
    ['/price/\\:fixed', ['/price/:fixed']],
    ['/a{/b}{/c}', ['/a', '/a/b', '/a/c', '/a/b/c']],
  ])('%s', (path, patterns) => {
    expect(expressPattern(path).sort()).toEqual([...patterns].sort());
  });

  it.each(['/users/:', '/open{', '/close}', '/star/*'])('gives no pattern for the malformed %s', (path) => {
    expect(expressPattern(path)).toEqual([]);
  });

  it('caps the variants of many optional groups', () => {
    const many = expressPattern('/x{/a}{/b}{/c}{/d}{/e}{/f}{/g}{/h}');
    expect(many.length).toBeLessThanOrEqual(16);
    expect(many).toContain('/x');
  });
});

const handler = (_req: unknown, res: express.Response) => void res.send('ok');

describe('expressRoutes()', () => {
  it('lists routes, route chains, arrays and all()', () => {
    const app = express();
    app.get('/', handler);
    app.route('/items').get(handler).post(handler);
    app.all('/any/:x', handler);
    app.get(['/a', '/b/:id'], handler);
    app.get('/docs{/:page}', handler);
    const { patterns, unresolved } = expressRoutes(app);
    expect(patterns.sort()).toEqual(
      ['/', '/any/[x]', '/a', '/b/[id]', '/docs', '/docs/[page]', '/items'].sort(),
    );
    expect(unresolved).toBe(0);
  });

  it('walks nested routers with their prefixes', () => {
    const app = express();
    const api = express.Router();
    const admin = express.Router();
    admin.get('/stats', handler);
    admin.route('/users/:id').get(handler).delete(handler);
    api.get('/health', handler);
    api.use('/admin', admin);
    app.use('/api/v1', api);
    const { patterns } = expressRoutes(app);
    expect(patterns.sort()).toEqual(
      ['/api/v1/admin/stats', '/api/v1/admin/users/[id]', '/api/v1/health'].sort(),
    );
  });

  it('reads parameters in mount paths and routers mounted without a path', () => {
    const app = express();
    const tenant = express.Router({ mergeParams: true });
    tenant.get('/dashboard', handler);
    const flat = express.Router();
    flat.get('/flat', handler);
    app.use('/tenants/:tenant', tenant);
    app.use(flat);
    const { patterns, unresolved } = expressRoutes(app);
    expect(patterns.sort()).toEqual(['/flat', '/tenants/[tenant]/dashboard']);
    expect(unresolved).toBe(0);
  });

  it('reads wildcard mounts and mounts with several paths', () => {
    const app = express();
    const files = express.Router();
    files.get('/info', handler);
    app.use('/files/*rest', files);
    const both = express.Router();
    both.get('/ping', handler);
    app.use(['/x', '/y'], both);
    const { patterns } = expressRoutes(app);
    expect(patterns).toContain('/files/[...rest]/info');
    expect(patterns).toContain('/x/ping');
    expect(patterns).toContain('/y/ping');
  });

  it('lists a sub-app as a catch-all below its mount and ignores middleware', () => {
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => next());
    app.use('/sub', express());
    app.get('/here', handler);
    const { patterns } = expressRoutes(app);
    expect(patterns.sort()).toEqual(['/here', '/sub/[[...splat]]']);
  });

  it('skips routes registered with a regular expression and counts unreadable mounts', () => {
    const app = express();
    const router = express.Router();
    router.get('/inside', handler);
    app.get(/^\/legacy\/(\d+)$/, handler);
    app.use(/^\/rx/, router);
    app.get('/plain', handler);
    const { patterns, unresolved } = expressRoutes(app);
    expect(patterns).toEqual(['/plain']);
    expect(unresolved).toBe(1);
  });

  it('survives routers that mount themselves in a cycle', () => {
    const app = express();
    const loop = express.Router();
    loop.get('/in', handler);
    loop.use('/again', loop);
    app.use('/loop', loop);
    expect(expressRoutes(app).patterns).toContain('/loop/in');
  });

  it('always puts the RegExp.prototype.exec it observed back', () => {
    const before = RegExp.prototype.exec;
    const app = express();
    const router = express.Router();
    router.get('/x', handler);
    app.use('/m/:id', router);
    app.use(/^\/rx/, router);
    expressRoutes(app);
    expect(RegExp.prototype.exec).toBe(before);
  });

  it('accepts a bare router and an empty source', () => {
    const router = express.Router();
    router.get('/r', handler);
    expect(expressRoutes(router).patterns).toEqual(['/r']);
    expect(expressRoutes({})).toEqual({ patterns: [], unresolved: 0 });
  });
});

describe('expressManifest()', () => {
  it('describes the app as dynamic Node endpoints under the express framework name', () => {
    const app = express();
    app.get('/', handler);
    app.get('/users/:id', handler);
    const manifest = expressManifest(app);
    expect(manifest.framework?.name).toBe('express');
    expect(manifest.framework?.version).toMatch(/^5\./);
    expect(manifest.buildId).toBe('runtime');
    const byPath = new Map(manifest.routes.map((route) => [route.pathname, route]));
    expect(byPath.get('/')).toMatchObject({
      kind: 'endpoint',
      runtime: 'nodejs',
      dynamic: false,
      id: 'endpoint:/',
    });
    expect(byPath.get('/users/[id]')).toMatchObject({ dynamic: true, id: 'endpoint:/users/[id]' });
    expect(new RegExp(byPath.get('/users/[id]')!.regex).test('/users/42')).toBe(true);
    expect(new RegExp(byPath.get('/users/[id]')!.regex).test('/users/42/extra')).toBe(false);
  });

  it('adds the routes option, in Express or Hypdriv syntax, without duplicates', () => {
    const app = express();
    app.get('/users/:id', handler);
    const manifest = expressManifest(app, {
      version: '5.9.9',
      buildId: 'b1',
      routes: ['/legacy/:id', '/files/[...path]', 'bare', '/users/:id'],
    });
    expect(manifest.framework?.version).toBe('5.9.9');
    expect(manifest.buildId).toBe('b1');
    expect(manifest.routes.map((route) => route.pathname).sort()).toEqual(
      ['/bare', '/files/[...path]', '/legacy/[id]', '/users/[id]'].sort(),
    );
  });

  it('gives an empty manifest for no app', () => {
    expect(expressManifest(undefined).routes).toEqual([]);
  });
});

describe('checkOrder()', () => {
  it('reports nothing for an app that registers hypdriv() first', () => {
    const app = express();
    const middleware = hypdriv(options);
    app.use(compression());
    app.use(middleware);
    app.use(express.static(mkdtempSync(join(tmpdir(), 'hypdriv-order-'))));
    app.get('/', handler);
    expect(checkOrder(app, middleware)).toEqual([]);
  });

  it('warns about routes, routers and static files that answer first', () => {
    const app = express();
    const middleware = hypdriv(options);
    app.get('/early', handler);
    app.use('/api', express.Router());
    app.use(express.static(mkdtempSync(join(tmpdir(), 'hypdriv-order-'))));
    app.use(middleware);
    const [problem, ...rest] = checkOrder(app, middleware);
    expect(rest).toEqual([]);
    expect(problem).toContain('the route /early');
    expect(problem).toContain('a mounted router');
    expect(problem).toContain('a static file server');
    expect(problem).toContain('Register hypdriv() before');
  });

  it('warns about a compression() that comes after it', () => {
    const app = express();
    const middleware = hypdriv(options);
    app.use(middleware);
    app.use(compression());
    expect(checkOrder(app, middleware)).toEqual([
      expect.stringContaining('compression() is registered after hypdriv()'),
    ]);
  });

  it('says nothing when the middleware is not in the app', () => {
    const app = express();
    app.get('/', handler);
    expect(checkOrder(app, hypdriv(options))).toEqual([]);
  });
});

describe('ResponseCapture (through expressFetch)', () => {
  it('turns writeHead, headers and end into a Response', async () => {
    const response = await fetchFrom((_req, res) => {
      res.setHeader('x-before', '1');
      res.writeHead(201, { 'x-after': '2', 'set-cookie': ['a=1', 'b=2'] });
      res.end('created');
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-before')).toBe('1');
    expect(response.headers.get('x-after')).toBe('2');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
    expect(await response.text()).toBe('created');
  });

  it('accepts a status message and flat header arrays', async () => {
    const response = await fetchFrom((_req, res) => {
      res.writeHead(200, 'Fine And Dandy', ['x-flat', 'yes', 'x-flat-2', 'also']);
      res.end();
    });
    expect(response.statusText).toBe('Fine And Dandy');
    expect(response.headers.get('x-flat')).toBe('yes');
    expect(response.headers.get('x-flat-2')).toBe('also');
  });

  it('commits the implicit head on the first write and reports headersSent', async () => {
    let before = true;
    let after = false;
    let kept: unknown;
    const response = await fetchFrom((_req, res) => {
      before = res.headersSent;
      res.statusCode = 202;
      res.setHeader('x-late', 'v');
      res.write('a');
      after = res.headersSent;
      kept = res.getHeader('x-late');
      res.end('b');
    });
    expect(before).toBe(false);
    expect(after).toBe(true);
    expect(kept).toBe('v');
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('ab');
  });

  it('streams each write as it happens', async () => {
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await fetchFrom(async (_req, res) => {
      res.write('one');
      await gate;
      res.end('two');
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('one');
    release();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('two');
    expect((await reader.read()).done).toBe(true);
  });

  it('commits on flushHeaders() before any body', async () => {
    let release: () => void = noop;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const response = await fetchFrom(async (_req, res) => {
      res.setHeader('x-flushed', '1');
      res.flushHeaders();
      await gate;
      res.end('late');
    });
    expect(response.headers.get('x-flushed')).toBe('1');
    release();
    expect(await response.text()).toBe('late');
  });

  it('takes strings with encodings, buffers, typed arrays and array buffers', async () => {
    const response = await fetchFrom((_req, res) => {
      res.write('68656c6c6f', 'hex');
      res.write(Buffer.from(' '));
      res.write(new Uint8Array([119, 111]));
      res.write(new Uint8Array([114, 108]).buffer as never);
      res.end('d', 'utf8');
    });
    expect(await response.text()).toBe('hello world');
  });

  it('answers HEAD, 204, 205 and 304 without a body', async () => {
    const head = await fetchFrom((_req, res) => void res.end('ignored'), { method: 'HEAD' });
    expect(head.body).toBeNull();
    for (const status of [204, 205, 304]) {
      const response = await fetchFrom((_req, res) => {
        res.statusCode = status;
        res.end();
      });
      expect(response.status).toBe(status);
      expect(response.body).toBeNull();
    }
  });

  it('refuses a second head, an informational status and a bad chunk', async () => {
    const errors: unknown[] = [];
    await fetchFrom((_req, res) => {
      res.writeHead(200);
      try {
        res.writeHead(200);
      } catch (error) {
        errors.push(error);
      }
      try {
        res.write(42 as never);
      } catch (error) {
        errors.push(error);
      }
      res.end();
    });
    await fetchFrom((_req, res) => {
      try {
        res.writeHead(101);
      } catch (error) {
        errors.push(error);
      }
      res.end();
    });
    expect(errors.map((error) => (error as unknown as { code: string }).code)).toEqual([
      'ERR_HTTP_HEADERS_SENT',
      'ERR_INVALID_ARG_TYPE',
      'ERR_HTTP_INVALID_STATUS_CODE',
    ]);
  });

  it('ends once, whatever calls end() and write() do afterwards', async () => {
    const errors: string[] = [];
    let callbacks = 0;
    const response = await fetchFrom((_req, res) => {
      res.on('error', (error) => errors.push((error as unknown as { code: string }).code));
      res.end('once');
      res.end('twice', () => {
        callbacks += 1;
      });
      res.write('after');
    });
    expect(await response.text()).toBe('once');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(errors).toEqual(['ERR_STREAM_WRITE_AFTER_END']);
    expect(callbacks).toBe(1);
  });

  it('applies backpressure: write() says false until the reader drains, then drain is emitted', async () => {
    let accepted: boolean | undefined;
    let drained = false;
    const response = await fetchFrom((_req, res) => {
      res.on('drain', () => {
        drained = true;
        res.end();
      });
      accepted = res.write(Buffer.alloc(256 * 1024, 1));
    });
    expect(accepted).toBe(false);
    expect(drained).toBe(false);
    const reader = response.body!.getReader();
    let total = 0;
    for (let result = await reader.read(); !result.done; result = await reader.read())
      total += result.value.length;
    expect(total).toBe(256 * 1024);
    expect(drained).toBe(true);
  });

  it('drops writes once the reader cancelled and lets a waiting writer go on', async () => {
    let writes = 0;
    let drained = false;
    const response = await fetchFrom((_req, res) => {
      res.on('drain', () => {
        drained = true;
      });
      res.write(Buffer.alloc(256 * 1024));
      setTimeout(() => {
        writes += res.write('more') ? 1 : 0;
        res.end();
      }, 10);
    });
    await response.body!.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(drained).toBe(true);
    // No backpressure once nobody reads: write() accepts, and the bytes are dropped.
    expect(writes).toBe(1);
  });

  it('fails the response when the handler fails before answering', async () => {
    await expect(
      fetchFrom(() => {
        throw new Error('before');
      }),
    ).rejects.toThrow('before');
  });

  it('exposes the state, can fail by hand and puts the original methods back on restore()', async () => {
    const { IncomingMessage: Incoming, ServerResponse: Outgoing } = await import('node:http');
    const { Socket } = await import('node:net');
    const req = new Incoming(new Socket());
    req.method = 'GET';
    const res = new Outgoing(req);
    const originalWrite = res.write;
    const capture = new ResponseCapture(req, res);
    expect(res.write).not.toBe(originalWrite);
    expect(capture.headSent).toBe(false);
    expect(capture.ended).toBe(false);
    res.end('x');
    expect(capture.headSent).toBe(true);
    expect(capture.ended).toBe(true);
    expect(await (await capture.response).text()).toBe('x');
    capture.restore();
    expect(res.headersSent).toBe(false);
    capture.restore();

    const failing = new ResponseCapture(req, new Outgoing(req));
    failing.fail(new Error('never answered'));
    await expect(failing.response).rejects.toThrow('never answered');
    expect(failing.headSent).toBe(true);

    // After the head went out, a failure errors the body stream instead.
    const partial = new Outgoing(req);
    const started = new ResponseCapture(req, partial);
    partial.write('part');
    started.fail(new Error('mid-body'));
    await expect((await started.response).text()).rejects.toThrow('mid-body');
  });
});

describe('expressFetch()', () => {
  it('runs a request through a whole Express app, with routers, body parsers and error handlers', async () => {
    const app = express();
    const api = express.Router();
    api.post('/echo', express.json(), (req, res) => void res.status(201).json({ got: req.body, ip: req.ip }));
    api.get('/boom', () => {
      throw new Error('router failure');
    });
    app.use('/api', api);
    app.use((error: Error, _req: unknown, res: express.Response, _next: unknown) => {
      res.status(500).json({ handled: error.message });
    });
    const echo = await expressFetch(
      app,
      new Request('http://app.test/api/echo?x=1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ a: 1 }),
      }),
      { ip: '203.0.113.9' },
    );
    expect(echo.status).toBe(201);
    expect(await echo.json()).toEqual({ got: { a: 1 }, ip: '203.0.113.9' });
    const boom = await expressFetch(app, new Request('http://app.test/api/boom'));
    expect(boom.status).toBe(500);
    expect(await boom.json()).toEqual({ handled: 'router failure' });
    const missing = await expressFetch(app, new Request('http://app.test/api/nothing'));
    expect(missing.status).toBe(404);
  });

  it('streams a request body into the app and a response body out of it', async () => {
    const app = express();
    app.post('/upper', (req, res) => {
      res.type('text/plain');
      req.on('data', (chunk: Buffer) => res.write(chunk.toString().toUpperCase()));
      req.on('end', () => res.end('!'));
    });
    const response = await expressFetch(
      app,
      new Request('http://app.test/upper', { method: 'POST', body: 'abc' }),
    );
    expect(await response.text()).toBe('ABC!');
  });

  it('works with a bare router as well as with an app', async () => {
    const router = express.Router();
    // A bare router has none of the helpers an app adds to the response (`res.send`).
    router.get('/hi', (_req, res) => void res.end('hi'));
    expect(await (await expressFetch(router as never, new Request('http://app.test/hi'))).text()).toBe('hi');
    expect((await expressFetch(router as never, new Request('http://app.test/missing'))).status).toBe(404);
  });

  it('reports the url, host and forwarded headers the app asked for', async () => {
    const app = express();
    app.get('/where', (req, res) => {
      res.json({ host: req.get('host'), url: req.originalUrl, query: req.query });
    });
    const response = await expressFetch(app, new Request('http://shop.example:8443/where?a=1&b=two'));
    expect(await response.json()).toEqual({
      host: 'shop.example:8443',
      url: '/where?a=1&b=two',
      query: { a: '1', b: 'two' },
    });
  });
});
