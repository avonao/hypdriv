import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { type DiscoveredRoute, fromTanStackPath, normalizePathname } from '@hypdriv/vite';
import { type Config, Generator, getConfig, type RouteNode } from '@tanstack/router-generator';
import type { StartOptionsLike } from './options';

/** A route of the application as HypDriv sees it. */
export interface StartRoute {
  /** HypDriv's canonical pattern (`/posts/[postId]`, `/files/[...splat]`, `/[[lang]]/docs`). */
  pathname: string;
  /** `page` renders a component; `endpoint` is a server route (only `server` handlers). */
  kind: 'page' | 'endpoint';
  /** The route's file and its ancestors' (absolute): the code-split chunks a page loads. */
  files: string[];
  /** The route file, relative to the project root. */
  sourcePage: string;
  /** TanStack's route path (`/posts/$postId`, `/_auth/dashboard`). */
  frameworkId: string;
}

type GeneratorFs = NonNullable<ConstructorParameters<typeof Generator>[0]['fs']>;

/**
 * A file system for the generator that reads from disk and keeps every write in memory: route discovery must
 * never touch the application's files (the generator rewrites route boilerplate and writes the route tree).
 */
export function readOnlyGeneratorFs(): GeneratorFs {
  const written = new Map<string, { content: string; mtimeMs: bigint }>();
  let tick = 0n;
  const key = (path: string) => resolve(path);
  return {
    async stat(path) {
      const own = written.get(key(path));
      if (own) return { mtimeMs: own.mtimeMs, mode: 0o644, uid: 0, gid: 0 };
      const s = await fsp.stat(path, { bigint: true });
      return { mtimeMs: s.mtimeMs, mode: Number(s.mode), uid: Number(s.uid), gid: Number(s.gid) };
    },
    async rename(from, to) {
      const own = written.get(key(from));
      if (!own) return;
      written.delete(key(from));
      written.set(key(to), own);
    },
    async writeFile(path, content) {
      tick += 1n;
      written.set(key(path), { content, mtimeMs: BigInt(Date.now()) * 1_000_000n + tick });
    },
    async readFile(path) {
      const own = written.get(key(path));
      if (own) return { stat: { mtimeMs: own.mtimeMs }, fileContent: own.content };
      try {
        const [fileContent, s] = await Promise.all([
          fsp.readFile(path, 'utf8'),
          fsp.stat(path, { bigint: true }),
        ]);
        return { stat: { mtimeMs: s.mtimeMs }, fileContent };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'file-not-existing';
        throw err;
      }
    },
    async chmod() {},
    async chown() {},
  };
}

/** The router generator config TanStack Start derives from its options (`srcDirectory`, `router`). */
export function generatorConfig(
  root: string,
  options: StartOptionsLike = {},
  onNodes?: (nodes: RouteNode[]) => void,
): Config {
  const srcDirectory = options.srcDirectory ?? 'src';
  const { basepath: _basepath, ...router } = (options.router ?? {}) as Record<string, unknown> & {
    basepath?: string;
    routesDirectory?: string;
  };
  delete router.entry;
  const scratch = join(tmpdir(), 'hypdriv-tanstack-start', String(process.pid));
  return getConfig(
    {
      ...(router as Partial<Config>),
      target: 'react',
      routesDirectory: resolve(root, srcDirectory, router.routesDirectory ?? 'routes'),
      generatedRouteTree: join(scratch, 'routeTree.gen.ts'),
      tmpDir: join(scratch, 'tmp'),
      disableLogging: true,
      plugins: onNodes
        ? [{ name: 'hypdriv-route-discovery', onRouteTreeChanged: ({ routeNodes }) => onNodes(routeNodes) }]
        : [],
    },
    root,
  );
}

/**
 * Crawls the application's routes with TanStack's own route generator (the same configuration Start uses),
 * without writing anything. Returns the generator's route nodes (the root route excluded).
 */
export async function crawlStartRoutes(root: string, options: StartOptionsLike = {}): Promise<RouteNode[]> {
  let nodes: RouteNode[] = [];
  const config = generatorConfig(root, options, (found) => {
    nodes = found;
  });
  await new Generator({ config, root, fs: readOnlyGeneratorFs() }).run();
  return nodes;
}

/** Whether a node only defines server handlers (Start prunes those from the client route tree). */
export function isServerOnly(node: Pick<RouteNode, 'createFileRouteProps'>): boolean {
  const props = node.createFileRouteProps;
  return !!props && props.has('server') && props.size === 1;
}

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

/**
 * HypDriv routes from the generator's nodes: pathless layouts are dropped, server-only routes become endpoints,
 * everything else is a page; a layout and its index route (`/posts` and `/posts/`) are one page.
 */
export function startRoutesFromNodes(nodes: RouteNode[], root: string): StartRoute[] {
  const byKey = new Map<string, StartRoute>();
  for (const node of nodes) {
    if (node.isNonPath || node._fsRouteType === 'pathless_layout' || node._fsRouteType === '__root') continue;
    const routePath = node.routePath ?? '/';
    const pathname = fromTanStackPath(routePath);
    const kind: StartRoute['kind'] = isServerOnly(node) ? 'endpoint' : 'page';
    const files: string[] = [];
    for (let current: RouteNode | undefined = node; current; current = current.parent)
      if (current.fullPath) files.push(resolve(current.fullPath));
    const route: StartRoute = {
      pathname,
      kind,
      files,
      sourcePage: toPosix(relative(root, node.fullPath)),
      frameworkId: routePath,
    };
    const key = `${kind}:${pathname}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, route);
      continue;
    }
    // `/posts` (layout) and `/posts/` (index): the index is what the URL renders.
    const preferNew = routePath.endsWith('/') && !existing.frameworkId.endsWith('/');
    byKey.set(key, {
      ...(preferNew ? route : existing),
      files: [...new Set([...existing.files, ...route.files])],
    });
  }
  return [...byKey.values()].sort(
    (a, b) => a.pathname.localeCompare(b.pathname) || a.kind.localeCompare(b.kind),
  );
}

/**
 * Start's server-function endpoint (`/_serverFn/<id>`). Like every manifest pattern it is relative to the router's
 * base path, which the manifest records as `basePath`.
 */
export function serverFnPattern(options: StartOptionsLike = {}): string {
  return normalizePathname(`${options.serverFns?.base ?? '/_serverFn'}/[...id]`);
}

/** The router's base path as the manifest records it (`''` for the root). */
export function routerBasePath(options: StartOptionsLike = {}): string {
  const basepath = normalizePathname(options.router?.basepath ?? '/');
  return basepath === '/' ? '' : basepath;
}

/** The discovered routes in the shape `finalizeManifest()` takes (assets are added by the build). */
export function toDiscoveredRoutes(routes: StartRoute[], options: StartOptionsLike = {}): DiscoveredRoute[] {
  return [
    ...routes.map(
      (route): DiscoveredRoute => ({
        pathname: route.pathname,
        kind: route.kind,
        sourcePage: route.sourcePage,
        frameworkId: route.frameworkId,
      }),
    ),
    { pathname: serverFnPattern(options), kind: 'endpoint', frameworkId: 'server-functions' },
  ];
}
