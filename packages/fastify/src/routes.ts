import { emptyManifest, type HypManifest, type HypRoute, routeId, routePatternToRegex } from '@hypdriv/core';

// ---------------------------------------------------------------------------------------------------------------
// find-my-way URL syntax (Fastify 5) → Hypdriv's canonical syntax

type Node = { kind: 'text'; value: string } | { kind: 'param'; name: string } | { kind: 'wildcard' };

interface ParsedUrl {
  nodes: Node[];
  /** The last parameter is optional (`/orgs/:org?`): the route answers with and without it. */
  optional: boolean;
}

const NAME = /^[A-Za-z0-9_$]+/;

/** The index after the `)` that closes the regular expression opened at `start` (`(`), or -1. */
function closing(url: string, start: number): number {
  let depth = 0;
  for (let i = start; i < url.length; i += 1) {
    const c = url[i];
    if (c === '\\') i += 1;
    else if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseUrl(url: string): ParsedUrl {
  const nodes: Node[] = [];
  let text = '';
  let optional = false;
  const flush = () => {
    if (text) nodes.push({ kind: 'text', value: text });
    text = '';
  };
  let i = 0;
  while (i < url.length) {
    const c = url[i]!;
    if (c === ':' && url[i + 1] === ':') {
      text += ':';
      i += 2;
    } else if (c === ':') {
      const name = NAME.exec(url.slice(i + 1))?.[0];
      if (!name) {
        text += c;
        i += 1;
        continue;
      }
      flush();
      nodes.push({ kind: 'param', name });
      i += 1 + name.length;
      if (url[i] === '(') {
        const end = closing(url, i);
        i = end < 0 ? url.length : end;
      }
      if (url[i] === '?' && i === url.length - 1) {
        optional = true;
        i += 1;
      }
    } else if (c === '*') {
      flush();
      nodes.push({ kind: 'wildcard' });
      i += 1;
    } else {
      text += c;
      i += 1;
    }
  }
  flush();
  return { nodes, optional };
}

function render(nodes: Node[]): string {
  type Dynamic = Exclude<Node, { kind: 'text' }>;
  const segments: Node[][] = [[]];
  for (const node of nodes) {
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
    const first = segment.find((node): node is Dynamic => node.kind !== 'text');
    if (!first) return segment.map((node) => (node.kind === 'text' ? node.value : '')).join('');
    if (first.kind === 'wildcard')
      return segment.length === 1 && index === segments.length - 1 ? '[...splat]' : '[splat]';
    // A segment mixing text and parameters (`/:from-:to`, `/file.:ext`) is one dynamic segment for the manifest.
    return `[${first.name}]`;
  });
  const pattern = out.join('/') || '/';
  return pattern.startsWith('/') ? pattern : `/${pattern}`;
}

/**
 * Converts a Fastify route URL (find-my-way syntax: `/users/:id`, `/files/*`, `/orgs/:org?`, `/a/:from-:to`,
 * `/n/:id(^\\d+)`) to Hypdriv's canonical patterns (`/users/[id]`, `/files/[...splat]`). An optional parameter gives
 * one pattern with and one without it; a regular expression on a parameter is ignored (the manifest only needs the
 * shape).
 */
export function fastifyPattern(url: string): string[] {
  const { nodes, optional } = parseUrl(url);
  const patterns = [render(nodes)];
  if (optional) {
    const without = nodes.slice(0, -1);
    const last = without[without.length - 1];
    if (last?.kind === 'text' && last.value.length > 1 && last.value.endsWith('/'))
      without[without.length - 1] = { kind: 'text', value: last.value.slice(0, -1) };
    patterns.push(render(without));
  }
  return [...new Set(patterns)];
}

// ---------------------------------------------------------------------------------------------------------------
// Routes registered before the plugin

const TREE_LINE = /^((?:│ {3}| {4})*)(?:├── |└── )(.*)$/;
const METHODS = /^(.*?) \(([A-Z]+(?:, [A-Z]+)*)\)(?: .*)?$/;

/**
 * The route URLs in the output of `fastify.printRoutes()`. Fastify's `onRoute` hook only sees routes that are
 * registered after the plugin that adds it; the routes registered before are read back from the router's tree,
 * whose labels concatenate down each branch (`/` + `users/` + `:id`). A literal colon (`::`) is printed as a single
 * `:`, so it reads back as a parameter.
 */
export function routesFromTree(tree: string): string[] {
  const urls = new Set<string>();
  const stack: string[] = [];
  for (const line of tree.split('\n')) {
    const match = TREE_LINE.exec(line);
    if (!match) continue;
    const depth = match[1]!.length / 4;
    const withMethods = METHODS.exec(match[2]!);
    stack.length = depth;
    stack[depth] = withMethods ? withMethods[1]! : match[2]!;
    if (withMethods) urls.add(stack.join(''));
  }
  return [...urls];
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest

export interface FastifyManifestOptions {
  /** Reported in the manifest (`hypdriv manifest`): the Fastify version. */
  version?: string;
  /** The deployment's build id. Default `runtime`: the manifest is derived from the running app. */
  buildId?: string;
  /**
   * More route patterns, for what the router cannot tell the plugin (routes of a sub-server, a proxy's upstream
   * paths). Fastify syntax (`/admin/:section`, `/files/*`) or Hypdriv's (`/admin/[section]`, `/files/[...path]`).
   */
  routes?: readonly string[];
}

/**
 * The route manifest of a Fastify app: every route URL it registered (full URL, prefixes included) as a dynamic
 * Node endpoint. Fastify renders everything per request; the manifest gives route ids to rate limits, cache
 * policies, flags and logs and lets `hypdriv routes` list the app.
 */
export function fastifyManifest(urls: Iterable<string>, options: FastifyManifestOptions = {}): HypManifest {
  const extra = (options.routes ?? []).flatMap((route) =>
    route.includes('[') ? [route.startsWith('/') ? route : `/${route}`] : fastifyPattern(route),
  );
  const seen = new Map<string, HypRoute>();
  for (const pathname of [...[...urls].flatMap(fastifyPattern), ...extra]) {
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
    framework: { name: 'fastify', version: options.version ?? 'unknown' },
    routes: [...seen.values()],
  });
}
