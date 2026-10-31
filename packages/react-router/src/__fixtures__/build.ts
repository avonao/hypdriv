import { createElement, type ReactNode } from 'react';
import {
  Links,
  Meta,
  type MiddlewareFunction,
  Outlet,
  redirect,
  Scripts,
  type ServerBuild,
  useLoaderData,
} from 'react-router';
import handleRequest, { streamTimeout } from '../entry-server';
import { type HypDrivMiddlewareOptions, hyp, hypdrivContext, hypdrivMiddleware, nonce } from '../server';

/** The prerender token of the test builds. */
export const TEST_TOKEN = 'f'.repeat(64);

export interface TestBuildOptions {
  /** Options of the root middleware, `false` for none. */
  middleware?: HypDrivMiddlewareOptions | false;
  /** Extra root middleware that runs after HypDriv's. */
  extraMiddleware?: MiddlewareFunction<Response>[];
  ssr?: boolean;
}

function Layout({ children }: { children: ReactNode }) {
  return createElement(
    'html',
    { lang: 'en' },
    createElement('head', null, createElement(Meta), createElement(Links)),
    createElement('body', null, children, createElement(Scripts)),
  );
}

function Page() {
  const data = useLoaderData() as { requestId: string | null; nonce: string | null; fromContext: boolean };
  return createElement(
    'main',
    null,
    createElement('p', { 'data-testid': 'request-id' }, data.requestId ?? 'none'),
    createElement('p', { 'data-testid': 'nonce' }, data.nonce ?? 'none'),
    createElement('p', { 'data-testid': 'context' }, String(data.fromContext)),
  );
}

const flags = {
  hasAction: false,
  hasLoader: false,
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  hasDefaultExport: true,
  hasErrorBoundary: false,
};

/**
 * A hand-made React Router server build (what `virtual:react-router/server-build` exports): a root route with
 * HypDriv's middleware, `/` (index), `/page` (loader reading `hyp()`), `/api/ping` (resource route), `/login`
 * (action) and `/go` (loader redirect). Its entry is HypDriv's `entry.server`.
 */
export function testBuild(options: TestBuildOptions = {}): ServerBuild {
  const middleware: MiddlewareFunction<Response>[] = [
    ...(options.middleware === false ? [] : [hypdrivMiddleware(options.middleware ?? {})]),
    ...(options.extraMiddleware ?? []),
  ];
  const routes = {
    root: {
      id: 'root',
      path: '',
      module: { default: () => createElement(Outlet), Layout, middleware },
    },
    'routes/home': {
      id: 'routes/home',
      parentId: 'root',
      index: true,
      module: { default: () => createElement('h1', null, 'Home') },
    },
    'routes/page': {
      id: 'routes/page',
      parentId: 'root',
      path: 'page',
      module: {
        default: Page,
        loader: ({ context }: { context: { get(key: unknown): unknown } }) => ({
          requestId: hyp()?.requestId ?? null,
          nonce: nonce() ?? null,
          fromContext:
            (context.get(hypdrivContext) as { requestId?: string } | null)?.requestId === hyp()?.requestId,
        }),
      },
    },
    'routes/api.ping': {
      id: 'routes/api.ping',
      parentId: 'root',
      path: 'api/ping',
      module: {
        loader: () =>
          Response.json({ pong: true, requestId: hyp()?.requestId ?? null, runner: hyp()?.runner ?? null }),
      },
    },
    'routes/login': {
      id: 'routes/login',
      parentId: 'root',
      path: 'login',
      module: {
        default: () => createElement('form', { method: 'post' }),
        action: () => ({ ok: true }),
      },
    },
    'routes/go': {
      id: 'routes/go',
      parentId: 'root',
      path: 'go',
      module: { default: () => null, loader: () => redirect('/page') },
    },
  };
  const assetRoutes = {
    root: {
      ...flags,
      id: 'root',
      path: '',
      module: '/assets/root.js',
      imports: [],
      css: ['/assets/root.css'],
    },
    'routes/home': { ...flags, id: 'routes/home', parentId: 'root', index: true, module: '/assets/home.js' },
    'routes/page': {
      ...flags,
      id: 'routes/page',
      parentId: 'root',
      path: 'page',
      hasLoader: true,
      module: '/assets/page.js',
    },
    'routes/api.ping': {
      ...flags,
      id: 'routes/api.ping',
      parentId: 'root',
      path: 'api/ping',
      hasLoader: true,
      hasDefaultExport: false,
      module: '/assets/api.ping.js',
    },
    'routes/login': {
      ...flags,
      id: 'routes/login',
      parentId: 'root',
      path: 'login',
      hasAction: true,
      module: '/assets/login.js',
    },
    'routes/go': {
      ...flags,
      id: 'routes/go',
      parentId: 'root',
      path: 'go',
      hasLoader: true,
      module: '/assets/go.js',
    },
  };
  return {
    entry: { module: { default: handleRequest, streamTimeout } },
    routes,
    assets: {
      entry: { module: '/assets/entry.client.js', imports: [] },
      routes: assetRoutes,
      url: '/assets/manifest-test.js',
      version: 'test',
    },
    basename: '/',
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    ssr: options.ssr ?? true,
    isSpaMode: options.ssr === false,
    prerender: [],
    routeDiscovery: { mode: 'initial' },
    allowedActionOrigins: false,
  } as unknown as ServerBuild;
}
