import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compressStatic, createRequestListener, loadServer } from './node';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const made: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-rr-node-'));
  made.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function navigate(url: string): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        headers: {
          'user-agent': UA,
          accept: 'text/html',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function listen(root: string): Promise<string> {
  const server = createServer(await createRequestListener({ root }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const client = {
  'build/client/index.html': '<!doctype html><title>Home</title>',
  'build/client/about/index.html': '<!doctype html><title>About</title>',
  'build/client/assets/app-1.js': `console.log(${JSON.stringify('x'.repeat(4096))})`,
};

describe('Node server', () => {
  it('serves the build’s Hypdriv server entry with static files first', async () => {
    const root = project({
      ...client,
      // A server build with Hypdriv's entry (what the Vite plugin produces for Node).
      'build/server/index.js': [
        "export const assetsBuildDirectory = 'build/client';",
        "export const publicPath = '/';",
        'export const ssr = true;',
        'export const hypdriv = {',
        '  async fetch(request, input) {',
        '    const asset = input.assets ? await input.assets(request) : null;',
        "    if (asset) { asset.headers.set('x-through', 'entry'); return asset; }",
        "    const body = 'dynamic ' + new URL(request.url).pathname + ' ' + input.ip;",
        "    return new Response(body, { headers: { 'x-through': 'entry' } });",
        '  },',
        '  handler() {},',
        '  build() {},',
        '};',
      ].join('\n'),
    });
    const loaded = await loadServer({ root });
    expect(loaded.entry).toBe(true);
    const url = await listen(root);
    const about = await fetch(`${url}/about`, { headers: { 'user-agent': UA } });
    expect(about.headers.get('x-through')).toBe('entry');
    expect(await about.text()).toContain('<title>About</title>');
    const asset = await fetch(`${url}/assets/app-1.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(asset.headers.get('content-encoding')).toBe('gzip');
    expect(await asset.text()).toContain('xxxx');
    const dynamic = await fetch(`${url}/ssr`);
    expect(await dynamic.text()).toBe('dynamic /ssr 127.0.0.1');
  });

  it('wraps builds without Hypdriv’s entry using hypdriv.config and .hypdriv/manifest.json', async () => {
    const root = project({
      ...client,
      'hypdriv.config.mjs': "export default { site: { name: 'node-fallback' } };",
      // A single-page app build (ssr: false) without Hypdriv's entry: everything is static.
      'build/server/index.js':
        "export const assetsBuildDirectory = 'build/client'; export const ssr = false;",
    });
    const loaded = await loadServer({ root });
    expect(loaded.entry).toBe(false);
    const url = await listen(root);
    // A browser navigation (fetch() would send `sec-fetch-mode: cors`).
    const deep = await navigate(`${url}/account/settings`);
    expect(deep.status).toBe(200);
    expect(deep.body).toContain('<title>Home</title>');
    expect(deep.headers['x-request-id']).toBeTruthy();
    expect(deep.headers['content-security-policy']).toBeTruthy();
    const health = (await (await fetch(`${url}/_hypdriv/health`)).json()) as {
      service: string;
      runner: string;
    };
    expect(health).toMatchObject({ service: 'node-fallback', runner: 'host' });
  });

  it('refuses to start without a server build', async () => {
    await expect(loadServer({ root: project({}) })).rejects.toThrow(/server build not found/);
  });
});

describe('compressStatic', () => {
  const file = (body: string, type: string) =>
    new Response(body, { headers: { 'content-type': type, 'content-length': String(body.length) } });
  const gzip = new Request('http://x/a', { headers: { 'accept-encoding': 'gzip, br' } });

  it('gzips compressible files for clients that accept it', async () => {
    const res = compressStatic(gzip, file('a'.repeat(4096), 'text/css'));
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('content-length')).toBeNull();
    expect(res.headers.get('vary')).toBe('Accept-Encoding');
    const plain = new Response(res.body!.pipeThrough(new DecompressionStream('gzip')));
    expect(await plain.text()).toBe('a'.repeat(4096));
  });

  it('leaves small, binary and unaccepted responses alone', () => {
    const small = file('a', 'text/css');
    expect(compressStatic(gzip, small)).toBe(small);
    const image = file('a'.repeat(4096), 'image/png');
    expect(compressStatic(gzip, image)).toBe(image);
    const plain = file('a'.repeat(4096), 'text/css');
    expect(compressStatic(new Request('http://x/a'), plain)).toBe(plain);
  });
});
