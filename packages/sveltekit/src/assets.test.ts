import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseClientEntry, parseNodeAssets, parseRouteNodes, routeAssets } from './assets';

// The shape SvelteKit 3.1 generates for `.svelte-kit/output/server/manifest-full.js`.
const MANIFEST = `export const manifest = (() => {
function __memo(fn) {
	let value;
	return () => value ??= (value = fn());
}

return {
	app_dir: "_app",
	app_path: "_app",
	assets: new Set(["robots.txt"]),
	mime_types: {".txt":"text/plain"},
	client: {start:"_app/immutable/entry/start.A.js",app:"_app/immutable/entry/app.B.js",imports:["_app/immutable/entry/start.A.js","_app/immutable/chunks/C.js","_app/immutable/entry/app.B.js"],stylesheets:["_app/immutable/assets/app.css"],fonts:["_app/immutable/assets/inter.woff2"],uses_env_dynamic_public:false},
	nodes: [
		__memo(() => import('./nodes/0.js')),
		__memo(() => import('./nodes/1.js')),
		__memo(() => import('./nodes/2.js')),
		__memo(() => import('./nodes/3.js'))
	],
	remotes: {},
	routes: [
		{
			id: "/",
			pattern: /^\\/$/,
			params: [],
			page: { layouts: [0,], errors: [1,], leaf: 2 },
			endpoint: null
		},
		{
			id: "/api/hello",
			pattern: /^\\/api\\/hello\\/?$/,
			params: [],
			page: null,
			endpoint: __memo(() => import('./entries/endpoints/api/hello/_server.ts.js'))
		},
		{
			id: "/(app)/blog/[slug]",
			pattern: /^\\/blog\\/([^/]+?)\\/?$/,
			params: [{"name":"slug","optional":false,"rest":false,"chained":false}],
			page: { layouts: [0,,], errors: [1,,], leaf: 3 },
			endpoint: null
		}
	],
	prerendered_routes: new Set([]),
	matchers: async () => ({}),
	server_assets: {}
}
})();
`;

const node = (
  index: number,
  imports: string[],
  stylesheets: string[] = [],
  fonts: string[] = [],
) => `export const index = ${index};
let component_cache;
export const component = async () => component_cache ??= (await import('../entries/pages/_page.svelte.js')).default;
export const imports = ${JSON.stringify(imports)};
export const stylesheets = ${JSON.stringify(stylesheets)};
export const fonts = ${JSON.stringify(fonts)};
`;

describe('server output parsing', () => {
  it('reads the client entry', () => {
    expect(parseClientEntry(MANIFEST)).toEqual({
      start: '_app/immutable/entry/start.A.js',
      app: '_app/immutable/entry/app.B.js',
      imports: [
        '_app/immutable/entry/start.A.js',
        '_app/immutable/chunks/C.js',
        '_app/immutable/entry/app.B.js',
      ],
      stylesheets: ['_app/immutable/assets/app.css'],
      fonts: ['_app/immutable/assets/inter.woff2'],
    });
    expect(parseClientEntry('export const manifest = {}')).toBeNull();
  });

  it('maps routes to their layout and leaf nodes', () => {
    expect([...parseRouteNodes(MANIFEST)]).toEqual([
      ['/', [0, 2]],
      ['/(app)/blog/[slug]', [0, 3]],
    ]);
  });

  it("reads a node's assets", () => {
    expect(parseNodeAssets(node(2, ['_app/immutable/nodes/2.js'], ['_app/x.css']))).toEqual({
      imports: ['_app/immutable/nodes/2.js'],
      stylesheets: ['_app/x.css'],
      fonts: [],
    });
  });
});

describe('routeAssets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hypdriv-sk-assets-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'nodes'), { recursive: true });
  writeFileSync(join(dir, 'manifest-full.js'), MANIFEST);
  writeFileSync(
    join(dir, 'nodes', '0.js'),
    node(0, ['_app/immutable/nodes/0.js', '_app/immutable/chunks/C.js'], ['_app/immutable/assets/0.css']),
  );
  writeFileSync(
    join(dir, 'nodes', '2.js'),
    node(2, ['_app/immutable/nodes/2.js', '_app/immutable/chunks/D.js']),
  );
  writeFileSync(
    join(dir, 'nodes', '3.js'),
    node(
      3,
      ['_app/immutable/nodes/3.js'],
      [],
      ['_app/immutable/assets/mono.woff2', '_app/immutable/assets/x.svg'],
    ),
  );

  it('combines the client entry with the route nodes under the public base', () => {
    const assets = routeAssets(dir, '/docs');
    expect(assets.get('/')).toEqual({
      js: [
        '/docs/_app/immutable/entry/start.A.js',
        '/docs/_app/immutable/chunks/C.js',
        '/docs/_app/immutable/entry/app.B.js',
        '/docs/_app/immutable/nodes/0.js',
        '/docs/_app/immutable/nodes/2.js',
        '/docs/_app/immutable/chunks/D.js',
      ],
      css: ['/docs/_app/immutable/assets/app.css', '/docs/_app/immutable/assets/0.css'],
      fonts: ['/docs/_app/immutable/assets/inter.woff2'],
      main: [
        '/docs/_app/immutable/entry/start.A.js',
        '/docs/_app/immutable/entry/app.B.js',
        '/docs/_app/immutable/nodes/2.js',
      ],
    });
    expect(assets.get('/(app)/blog/[slug]')?.fonts).toEqual([
      '/docs/_app/immutable/assets/inter.woff2',
      '/docs/_app/immutable/assets/mono.woff2',
    ]);
    expect(assets.has('/api/hello')).toBe(false);
  });

  it('uses an absolute assets origin as is and degrades to nothing without a manifest', () => {
    expect(routeAssets(dir, 'https://cdn.example.com/').get('/')?.main[0]).toBe(
      'https://cdn.example.com/_app/immutable/entry/start.A.js',
    );
    expect(routeAssets(join(dir, 'missing'), '/').size).toBe(0);
  });
});
