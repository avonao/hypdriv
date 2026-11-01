import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoveredRoutes, parseJsonc, scanWorkerRoutes } from './scan';

const created: string[] = [];

afterAll(() => {
  for (const d of created) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'hypdriv-rwsdk-scan-'));
  created.push(root);
  for (const [path, content] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

/** The scan of a project whose Worker entry is `src/worker.tsx`. */
function scan(files: Record<string, string>) {
  const root = project(files);
  const result = scanWorkerRoutes(root, join(root, 'src', 'worker.tsx'));
  return { ...result, root, summary: result.routes.map((r) => `${r.kind} ${r.path}`) };
}

const IMPORTS = `import { except, index, layout, prefix, render, route } from 'rwsdk/router';
import { defineApp } from 'rwsdk/worker';
`;

describe('scanWorkerRoutes', () => {
  it('reads the routes of defineApp and tells pages from endpoints', () => {
    const { summary, warnings } = scan({
      'src/worker.tsx': `${IMPORTS}
export default defineApp([
  render(Document, [
    route('/', () => <Home />),
    route('/about', About),
    index(Home),
  ]),
  route('/api/ping', { get: () => Response.json({ ok: true }) }),
  route('/api/echo', async ({ request }) => new Response(await request.text())),
]);
`,
    });
    expect(summary).toEqual(['page /', 'page /about', 'page /', 'endpoint /api/ping', 'endpoint /api/echo']);
    expect(warnings).toEqual([]);
  });

  it('joins prefixes, follows layouts and render, and skips middleware and except handlers', () => {
    const { summary, warnings } = scan({
      'src/worker.tsx': `${IMPORTS}
const requireUser = () => {};
export default defineApp([
  requireUser,
  render(Document, [
    prefix('/blog', [
      route('/', () => <Blog />),
      route('/post/:id', [requireUser, ({ params }) => <Post id={params.id} />]),
      prefix('/admin/', [layout(AdminLayout, [route('/stats', () => <Stats />)])]),
      except(() => new Response('blog error')),
    ]),
  ]),
  except(() => new Response('error')),
]);
`,
    });
    expect(summary).toEqual(['page /blog/', 'page /blog/post/:id', 'page /blog/admin/stats']);
    expect(warnings).toEqual([]);
  });

  it('follows route arrays imported from other files: relative imports, tsconfig paths, barrels and re-exports', () => {
    const { summary, warnings, files } = scan({
      'tsconfig.json': `{
  // comments and trailing commas are fine
  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },
}`,
      'src/worker.tsx': `${IMPORTS}
import { blog } from './app/blog';
import { shop } from '@/app/shop';
import shopApi from '@/app/api';
import * as admin from './app/admin';
export default defineApp([render(Document, [route('/', () => <Home />), prefix('/blog', blog), ...shop, admin.routes]), ...shopApi]);
`,
      'src/app/blog.tsx': `import { route } from 'rwsdk/router';
import { Post } from './pages/Post';
export const blog = [route('/', () => <Index />), route('/:slug', Post)];
`,
      'src/app/pages/Post.tsx': 'export const Post = ({ params }) => <article>{params.slug}</article>;\n',
      'src/app/shop/index.ts': "export { shop } from './routes';\n",
      'src/app/shop/routes.tsx': `import { route } from 'rwsdk/router';
export const shop = [route('/shop', () => <Shop />), route('/shop/:sku', () => <Sku />)];
`,
      'src/app/api.ts': `import { route } from 'rwsdk/router';
export default [route('/api/health', { get: () => new Response('ok') })];
`,
      'src/app/admin.tsx': `import { route } from 'rwsdk/router';
export const routes = route('/admin', () => <Admin />);
`,
    });
    expect(summary).toEqual([
      'page /',
      'page /blog/',
      'page /blog/:slug',
      'page /shop',
      'page /shop/:sku',
      'page /admin',
      'endpoint /api/health',
    ]);
    expect(warnings).toEqual([]);
    expect(files.length).toBe(7);
  });

  it('records which file declares each route', () => {
    const { routes, root } = scan({
      'src/worker.tsx': `${IMPORTS}import { feed } from './feed';\nexport default defineApp([route('/', () => <Home />), feed]);\n`,
      'src/feed.ts':
        "import { route } from 'rwsdk/router';\nexport const feed = route('/feed.xml', () => new Response('<rss/>'));\n",
    });
    expect(discoveredRoutes(root, routes)).toEqual([
      { pathname: '/', kind: 'page', sourcePage: 'src/worker.tsx' },
      { pathname: '/feed.xml', kind: 'endpoint', sourcePage: 'src/feed.ts' },
    ]);
  });

  it('finds the app behind a const, a wrapper and a spread', () => {
    const viaConst = scan({
      'src/worker.tsx': `${IMPORTS}const app = defineApp([route('/a', () => <A />)]);\nexport default app;\n`,
    });
    expect(viaConst.summary).toEqual(['page /a']);

    const wrapped = scan({
      'src/worker.tsx': `${IMPORTS}import { hypdrivMiddleware, withHypDriv } from '@hypdriv/rwsdk/worker';
export default withHypDriv(defineApp([hypdrivMiddleware(), route('/a', () => <A />)])) satisfies Handler;
`,
    });
    expect(wrapped.summary).toEqual(['page /a']);
    expect(wrapped.wrapped).toBe(true);
    expect(wrapped.middleware).toBe(true);

    const spread = scan({
      'src/worker.tsx': `${IMPORTS}export default { ...defineApp([route('/a', () => <A />)]), scheduled() {} };\n`,
    });
    expect(spread.summary).toEqual(['page /a']);
  });

  it('reports a Worker entry that is not wrapped or lacks the nonce middleware', () => {
    const plain = scan({
      'src/worker.tsx': `${IMPORTS}export default defineApp([route('/a', () => <A />)]);\n`,
    });
    expect(plain.wrapped).toBe(false);
    expect(plain.middleware).toBe(false);

    const noMiddleware = scan({
      'src/worker.tsx': `${IMPORTS}import { withHypDriv } from '@hypdriv/rwsdk/worker';
export default withHypDriv(defineApp([route('/a', () => <A />)]));
`,
    });
    expect(noMiddleware.wrapped).toBe(true);
    expect(noMiddleware.middleware).toBe(false);
  });

  it('understands renamed and namespace imports of the router', () => {
    const { summary } = scan({
      'src/worker.tsx': `import { route as r, prefix as under } from 'rwsdk/router';
import * as rw from 'rwsdk/worker';
import * as router from 'rwsdk/router';
export default rw.defineApp([r('/a', () => <A />), under('/b', [router.route('/c', () => <C />)])]);
`,
    });
    expect(summary).toEqual(['page /a', 'page /b/c']);
  });

  it('reads conditional routes and routes a function builds', () => {
    const { summary, warnings } = scan({
      'src/worker.tsx': `${IMPORTS}
const adminRoutes = () => [route('/admin', () => <Admin />)];
const withAuth = () => (info) => {};
export default defineApp([
  withAuth(),
  process.env.FEATURE ? route('/beta', () => <Beta />) : [],
  ...adminRoutes(),
  ...(flag && [route('/flagged', () => <Flagged />)]),
]);
`,
    });
    expect(summary).toEqual(['page /beta', 'page /admin', 'page /flagged']);
    expect(warnings).toEqual([]);
  });

  it('accepts a template literal path and reports a computed one', () => {
    const { summary, warnings } = scan({
      'src/worker.tsx': `${IMPORTS}
const base = '/dyn';
export default defineApp([
  route(\`/literal\`, () => <A />),
  route(base + '/x', () => <B />),
  prefix(\`\${base}\`, [route('/y', () => <C />)]),
]);
`,
    });
    expect(summary).toEqual(['page /literal']);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('computed');
  });

  describe('page or endpoint', () => {
    const kinds = (body: string, extra: Record<string, string> = {}) =>
      scan({ 'src/worker.tsx': `${IMPORTS}${body}`, ...extra }).summary;

    it('follows the handler that is a local component or function', () => {
      expect(
        kinds(`
const Landing = () => <main />;
function Legacy() { return <p />; }
const handler = () => new Response('x');
export default defineApp([route('/a', Landing), route('/b', Legacy), route('/c', handler)]);
`),
      ).toEqual(['page /a', 'page /b', 'endpoint /c']);
    });

    it('follows an imported handler into its file', () => {
      expect(
        kinds(
          "import { Page } from './page';\nimport { api } from './api';\nexport default defineApp([route('/a', Page), route('/b', api)]);\n",
          {
            'src/page.tsx': 'export const Page = () => <main />;\n',
            'src/api.ts': 'export const api = () => Response.json({});\n',
          },
        ),
      ).toEqual(['page /a', 'endpoint /b']);
    });

    it('lets the last entry of a middleware array and the GET of a method table decide', () => {
      expect(
        kinds(`
export default defineApp([
  route('/a', [guard, () => <A />]),
  route('/b', [guard, () => new Response('x')]),
  route('/c', { get: () => <C />, post: () => new Response('x') }),
  route('/d', { get: () => new Response('x') }),
]);
`),
      ).toEqual(['page /a', 'endpoint /b', 'page /c', 'endpoint /d']);
    });

    it('falls back to the naming convention for handlers it cannot read', () => {
      expect(
        kinds(`
import { Dashboard } from 'some-ui-kit';
import { handleHook } from 'some-hooks';
export default defineApp([route('/a', Dashboard), route('/b', handleHook)]);
`),
      ).toEqual(['page /a', 'endpoint /b']);
    });
  });

  describe('what it cannot read', () => {
    it('reports a missing Worker entry', () => {
      const root = project({});
      const result = scanWorkerRoutes(root, join(root, 'src', 'worker.tsx'));
      expect(result.routes).toEqual([]);
      expect(result.warnings[0]).toContain('does not exist');
    });

    it('reports an entry without a default export or without defineApp', () => {
      expect(scan({ 'src/worker.tsx': 'export const app = 1;\n' }).warnings[0]).toContain(
        'no default export',
      );
      expect(scan({ 'src/worker.tsx': 'export default { fetch() {} };\n' }).warnings[0]).toContain(
        'no `defineApp([...])` call',
      );
    });

    it('reports an unresolvable route array and an unreadable file but keeps the rest', () => {
      const { summary, warnings } = scan({
        'src/worker.tsx': `${IMPORTS}import { more } from './missing';
import { broken } from './broken';
export default defineApp([route('/ok', () => <Ok />), ...more, ...broken, ...undefinedName]);
`,
        'src/broken.ts': 'export const broken = [ (;\n',
      });
      expect(summary).toEqual(['page /ok']);
      expect(warnings.join('\n')).toContain('could not read src/broken.ts');
      expect(warnings.join('\n')).toContain('could not resolve `undefinedName`');
    });

    it('does not loop on a route array that refers to itself', () => {
      const { summary } = scan({
        'src/worker.tsx': `${IMPORTS}const routes = [route('/a', () => <A />), ...routes];\nexport default defineApp(routes);\n`,
      });
      expect(summary).toEqual(['page /a']);
    });
  });
});

describe('discoveredRoutes', () => {
  it('converts RedwoodSDK paths to Hypdriv patterns and drops duplicates', () => {
    const root = '/app';
    const file = '/app/src/worker.tsx';
    expect(
      discoveredRoutes(root, [
        { path: '/users/:id/', kind: 'page', file },
        { path: '/users/:id', kind: 'page', file },
        { path: '/files/*', kind: 'endpoint', file },
        { path: '/files/*', kind: 'page', file },
      ]),
    ).toEqual([
      { pathname: '/users/[id]', kind: 'page', sourcePage: 'src/worker.tsx' },
      { pathname: '/files/[...splat]', kind: 'endpoint', sourcePage: 'src/worker.tsx' },
      { pathname: '/files/[...splat]', kind: 'page', sourcePage: 'src/worker.tsx' },
    ]);
  });
});

describe('parseJsonc', () => {
  it('reads JSON with comments and trailing commas, and leaves strings alone', () => {
    expect(
      parseJsonc(`{
  // line
  "a": "http://example.com/*not a comment*/", /* block */
  "b": [1, 2,],
}`),
    ).toEqual({ a: 'http://example.com/*not a comment*/', b: [1, 2] });
  });
});
