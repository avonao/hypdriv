import { afterEach, describe, expect, it } from 'vitest';
import { setBuilding, setDev } from './__fixtures__/app-env';
import { HANDLER_SLOT, registeredHandler } from './handle';
import { hypdriv } from './hooks';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function event(path: string) {
  const request = new Request(`https://example.com${path}`, {
    headers: { 'user-agent': UA, accept: 'text/html' },
  });
  return {
    request,
    url: new URL(request.url),
    route: { id: path },
    params: {},
    locals: {},
    platform: undefined,
    isDataRequest: false,
    isSubRequest: false,
    isRemoteRequest: false,
    getClientAddress: () => '203.0.113.9',
  };
}

const page = () =>
  new Response('<html><head></head><body><script>boot()</script></body></html>', {
    headers: { 'content-type': 'text/html' },
  });

afterEach(() => {
  setBuilding(false);
  setDev(false);
  delete (globalThis as Record<symbol, unknown>)[HANDLER_SLOT];
});

describe('hypdriv() from @hypdriv/sveltekit/hooks', () => {
  it('registers its handler for the Node server and runs the pipeline with the build config', async () => {
    const handle = hypdriv({ target: 'node', development: false });
    expect(typeof registeredHandler()).toBe('function');
    const response = await handle({ event: event('/ssr') as never, resolve: async () => page() });
    const policy = response.headers.get('content-security-policy') ?? '';
    // SvelteKit's `csp` directives (virtual:hypdriv/sveltekit) and Hypdriv's own (virtual:hypdriv/config).
    expect(policy).toContain('https://js.example.com');
    expect(policy).toContain('https://img.example.com');
    expect(response.headers.get('x-hypdriv-csp')).toBe('nonce');
    expect(await response.text()).toMatch(/<script nonce="[^"]+">boot\(\)<\/script>/);
  });

  it('passes through while `building` from $app/env is true', async () => {
    const handle = hypdriv({ target: 'node' });
    setBuilding(true);
    const response = await handle({ event: event('/ssr') as never, resolve: async () => page() });
    expect(response.headers.get('x-request-id')).toBeNull();
    expect(await response.text()).toContain('<script>boot()</script>');
  });

  it('answers /_hypdriv/* in the dev server', async () => {
    const handle = hypdriv({ target: 'node', development: true });
    setDev(true);
    const response = await handle({
      event: event('/_hypdriv/health') as never,
      resolve: async () => page(),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { framework: string }).framework).toContain('SvelteKit');
  });
});
