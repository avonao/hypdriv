import { createRequire } from 'node:module';
import { emptyManifest, type HypManifest, type HypRoute, routeId, routePatternToRegex } from '@hypdriv/core';

/** A layer of Express' router stack, as far as the manifest reads it. */
export interface ExpressLayerLike {
  readonly name?: string;
  readonly route?: { readonly path?: unknown };
  readonly handle?: unknown;
  readonly matchers?: ReadonlyArray<(path: string) => unknown>;
}

/** What the manifest reads: an Express 5 app (`app.router`) or any router (`router.stack`). */
export interface ExpressRoutesSource {
  readonly router?: { readonly stack?: readonly ExpressLayerLike[] };
  readonly stack?: readonly ExpressLayerLike[];
}

export interface ExpressManifestOptions {
  /** Reported in the manifest (`hypdriv manifest`). Default: the installed Express version. */
  version?: string;
  /** The deployment's build id. Default `runtime`: the manifest is derived from the running app. */
  buildId?: string;
  /**
   * More route patterns, for what the router stack cannot tell: routes registered with a regular expression, the
   * routes inside a sub-app (`app.use('/admin', adminApp)`). Express syntax (`/admin/:section`, `/files/*path`) or
   * Hypdriv's (`/admin/[section]`, `/files/[...path]`).
   */
  routes?: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------
// path-to-regexp 8 syntax (Express 5) → Hypdriv's canonical syntax

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'param'; name: string }
  | { kind: 'wildcard'; name: string }
  | { kind: 'optional'; children: Node[] };

function parsePath(path: string): Node[] | null {
  let i = 0;
  const parseSequence = (closing: boolean): Node[] | null => {
    const nodes: Node[] = [];
    let text = '';
    const flush = () => {
      if (text) nodes.push({ kind: 'text', value: text });
      text = '';
    };
    while (i < path.length) {
      const c = path[i]!;
      if (c === '\\') {
        text += path[i + 1] ?? '';
        i += 2;
      } else if (c === ':' || c === '*') {
        const match = /^[A-Za-z_$][\w$]*/.exec(path.slice(i + 1));
        if (!match) return null;
        flush();
        nodes.push(c === ':' ? { kind: 'param', name: match[0] } : { kind: 'wildcard', name: match[0] });
        i += 1 + match[0].length;
      } else if (c === '{') {
        i += 1;
        flush();
        const children = parseSequence(true);
        if (!children) return null;
        nodes.push({ kind: 'optional', children });
      } else if (c === '}') {
        if (!closing) return null;
        i += 1;
        flush();
        return nodes;
      } else {
        text += c;
        i += 1;
      }
    }
    flush();
    return closing ? null : nodes;
  };
  return parseSequence(false);
}

const MAX_VARIANTS = 16;

/** Every spelling an optional group allows: with and without it (capped). */
function expand(nodes: Node[]): Node[][] {
  let variants: Node[][] = [[]];
  for (const node of nodes) {
    if (node.kind === 'optional') {
      const inner = expand(node.children);
      const next: Node[][] = [];
      for (const variant of variants) {
        next.push(variant);
        for (const extra of inner) next.push([...variant, ...extra]);
      }
      variants = next.slice(0, MAX_VARIANTS);
    } else variants = variants.map((variant) => [...variant, node]);
  }
  return variants;
}

function render(nodes: Node[]): string {
  type Dynamic = Extract<Node, { kind: 'param' | 'wildcard' }>;
  const segments: Array<Array<Node>> = [[]];
  for (const node of nodes) {
    if (node.kind === 'optional') continue;
    if (node.kind !== 'text') {
      segments[segments.length - 1]!.push(node);
      continue;
    }
    node.value.split('/').forEach((part, index) => {
      if (index > 0) segments.push([]);
      if (part) segments[segments.length - 1]!.push({ kind: 'text', value: part });
    });
  }
  const out = segments.map((segment, index) => {
    const dynamic = segment.filter(
      (node): node is Dynamic => node.kind === 'param' || node.kind === 'wildcard',
    );
    const first = dynamic[0];
    if (!first) return segment.map((node) => (node.kind === 'text' ? node.value : '')).join('');
    // A segment mixing text and a parameter (`/file.:ext`) is a dynamic segment for the manifest.
    return first.kind === 'wildcard' && segment.length === 1 && index === segments.length - 1
      ? `[...${first.name}]`
      : `[${first.name}]`;
  });
  return out.join('/') || '/';
}

/**
 * Converts an Express 5 path (`/users/:id`, `/files/*path`, `/book{/:chapter}`) to Hypdriv's canonical patterns
 * (`/users/[id]`, `/files/[...path]`; an optional group gives one pattern with and one without it), or `[]` for a
 * path that is not a string Express 5's syntax can express (a regular expression).
 */
export function expressPattern(path: string): string[] {
  const nodes = parsePath(path);
  if (!nodes) return [];
  return [
    ...new Set(
      expand(nodes).map((variant) => {
        const pattern = render(variant);
        return pattern.startsWith('/') ? pattern : `/${pattern}`;
      }),
    ),
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Mount points

/**
 * Express 5's router keeps the path of a mount only inside a compiled matcher (`Layer#matchers`), which has no
 * accessors. The matcher is a `path-to-regexp` closure over a regular expression, so the compiled expression is
 * observed while the matcher runs once, then read back as a pattern. The observation is a synchronous wrapper of
 * `RegExp.prototype.exec` that is always put back; if the shape of the expression is not one this reader knows
 * (a regular-expression mount, a custom regexp parameter), the mount is reported as unresolved.
 */
function compiledSource(matcher: (path: string) => unknown, input: string): string | null {
  const original = RegExp.prototype.exec;
  let seen: RegExp | null = null;
  RegExp.prototype.exec = function exec(this: RegExp, ...args: [string]) {
    seen ??= this;
    return original.apply(this, args);
  };
  try {
    matcher(input);
  } catch {
    return null;
  } finally {
    RegExp.prototype.exec = original;
  }
  return seen === null ? null : (seen as RegExp).source;
}

/** The literal and parameter parts of a `path-to-regexp` mount expression, or `null` when it holds anything else. */
function mountTokens(source: string): Array<{ kind: 'text' | 'param' | 'wildcard'; value: string }> | null {
  const body = /^\^\(\?:(.*)\)\(\?:\\\/\$\)\?\(\?=\\\/\|\$\)$/s.exec(source)?.[1];
  if (body === undefined) return null;
  const tokens: Array<{ kind: 'text' | 'param' | 'wildcard'; value: string }> = [];
  let i = 0;
  while (i < body.length) {
    if (body.startsWith('([^\\/]+)', i)) {
      tokens.push({ kind: 'param', value: '' });
      i += '([^\\/]+)'.length;
    } else if (body.startsWith('([^]+)', i)) {
      tokens.push({ kind: 'wildcard', value: '' });
      i += '([^]+)'.length;
    } else if (body[i] === '\\') {
      tokens.push({ kind: 'text', value: body[i + 1] ?? '' });
      i += 2;
    } else if ('()[]{}|*+?^$'.includes(body[i]!)) {
      return null;
    } else {
      tokens.push({ kind: 'text', value: body[i]! });
      i += 1;
    }
  }
  return tokens;
}

/** The mount pattern(s) of a router layer (`/api`, `/tenants/[tenant]`), or `null` when they cannot be read. */
function mountPatterns(layer: ExpressLayerLike): string[] | null {
  const matchers = layer.matchers;
  if (!matchers?.length) return null;
  const out: string[] = [];
  for (const matcher of matchers) {
    const source = compiledSource(matcher, '/');
    const tokens = source === null ? null : mountTokens(source);
    if (!tokens) return null;
    // A sample path that matches the expression names its parameters.
    let n = 0;
    const sample = tokens
      .map((token) =>
        token.kind === 'text' ? token.value : token.kind === 'param' ? `p${n++}` : `w${n++}/x`,
      )
      .join('');
    let names: string[] = [];
    try {
      const matched = matcher(sample) as { params?: Record<string, unknown> } | false;
      names = matched ? Object.keys(matched.params ?? {}) : [];
    } catch {
      names = [];
    }
    let k = 0;
    const path = tokens
      .map((token) => {
        if (token.kind === 'text') return token.value;
        const name = names[k] ?? `param${k}`;
        k += 1;
        return token.kind === 'param' ? `[${name}]` : `[...${name}]`;
      })
      .join('');
    out.push(path === '/' ? '' : path.replace(/\/+$/, ''));
  }
  return [...new Set(out)];
}

function stackOf(source: ExpressRoutesSource | undefined): readonly ExpressLayerLike[] | undefined {
  if (!source) return undefined;
  return source.stack ?? source.router?.stack;
}

function join(prefix: string, pattern: string): string {
  const path = `${prefix}${pattern === '/' ? '' : pattern}`;
  return path.startsWith('/') ? path || '/' : `/${path}`;
}

/** What walking a router stack found. */
export interface ExpressRoutes {
  /** Endpoint patterns in Hypdriv's syntax. */
  patterns: string[];
  /** Mounts whose path could not be read (the routes below them are not listed). */
  unresolved: number;
}

/**
 * The route patterns of an Express 5 app or router: every `app.get()`/`router.post()`/`app.route()`/`app.all()` path,
 * through any depth of mounted routers (`app.use('/api', router)` → `/api/users/[id]`). Sub-apps are listed as
 * `/<mount>/[[...splat]]`: their routers are not reachable from the parent.
 */
export function expressRoutes(source: ExpressRoutesSource): ExpressRoutes {
  const patterns = new Set<string>();
  let unresolved = 0;
  const visited = new Set<unknown>();
  const walk = (stack: readonly ExpressLayerLike[], prefixes: string[]) => {
    if (visited.has(stack)) return;
    visited.add(stack);
    for (const layer of stack) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const path of paths)
          if (typeof path === 'string')
            for (const pattern of expressPattern(path))
              for (const prefix of prefixes) patterns.add(join(prefix, pattern));
        continue;
      }
      const child = (layer.handle as { stack?: readonly ExpressLayerLike[] } | undefined)?.stack;
      const isRouter = Array.isArray(child);
      const isApp = layer.name === 'mounted_app';
      if (!isRouter && !isApp) continue;
      const mounts = mountPatterns(layer);
      if (!mounts) {
        unresolved += 1;
        continue;
      }
      const next = prefixes.flatMap((prefix) => mounts.map((mount) => `${prefix}${mount}`));
      if (isRouter) walk(child, next);
      else for (const prefix of next) patterns.add(join(prefix, '/[[...splat]]'));
    }
    visited.delete(stack);
  };
  const stack = stackOf(source);
  if (stack) walk(stack, ['']);
  return { patterns: [...patterns], unresolved };
}

function expressVersion(): string {
  try {
    return (
      (createRequire(import.meta.url)('express/package.json') as { version?: string }).version ?? 'unknown'
    );
  } catch {
    return 'unknown';
  }
}

/**
 * The route manifest of an Express app, derived from its router stack and the `routes` option. Express renders
 * everything per request, so every route is a dynamic endpoint: the manifest gives route ids to rate limits, cache
 * policies, flags and logs (`match: '/api/**'` works without it) and lets `hypdriv routes` list the app. Evaluated
 * when the handler first runs, after the app registered its routes.
 */
export function expressManifest(
  source: ExpressRoutesSource | undefined,
  options: ExpressManifestOptions = {},
): HypManifest {
  const found = source ? expressRoutes(source).patterns : [];
  const extra = (options.routes ?? []).flatMap((route) =>
    route.includes('[') ? [route.startsWith('/') ? route : `/${route}`] : expressPattern(route),
  );
  const seen = new Map<string, HypRoute>();
  for (const pathname of [...found, ...extra]) {
    if (seen.has(pathname)) continue;
    seen.set(pathname, {
      id: routeId('endpoint', pathname),
      pathname,
      regex: routePatternToRegex(pathname),
      kind: 'endpoint',
      classification: 'route',
      runtime: 'nodejs',
      dynamic: /\[[^\]]+\]/.test(pathname),
      assets: { js: [], css: [], fonts: [] },
    });
  }
  return emptyManifest({
    buildId: options.buildId ?? 'runtime',
    framework: { name: 'express', version: options.version ?? expressVersion() },
    routes: [...seen.values()],
  });
}
