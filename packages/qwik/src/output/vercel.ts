import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { VercelRoute } from '@hypdriv/build';
import { PRIVATE_BUILD_FILES, vercelNodeRuntime } from '@hypdriv/vite';

/** The Build Output function that renders every request the CDN cannot answer from a file. */
export const FUNCTION_NAME = '_qwik-router';

/** Client output files that configure other platforms: never part of the Vercel static output. */
const PLATFORM_FILES = new Set(['_headers', '_redirects', '_routes.json', '_worker.js', '.assetsignore']);

/** The server entry the Vercel build produces (`src/entry.vercel.tsx`). */
export function findVercelEntry(outputEntries: string[]): string | undefined {
  return outputEntries.find((name) => /^entry\.vercel\.[cm]?js$/.test(name));
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The Build Output routes of a Qwik app, in order:
 *
 * 1. Mutating requests (server actions are `POST`s to the page's own URL) go to the function, never to a file.
 * 2. `handle: filesystem`: the CDN answers hashed build files, public files and the root document.
 * 3. A path with a trailing slash that has a prerendered document (`/about/` → `/about/index.html`; without
 *    trailing slashes: `/about` → `/about/index.html`), only when that file exists (`check`).
 * 4. Everything else renders in the function; it also redirects between the spellings of a page's path.
 *
 * Hypdriv's header routes and Routing Middleware are inserted before `handle: filesystem` afterwards.
 */
export function vercelRoutes(input: { basePathname: string; noTrailingSlash: boolean }): VercelRoute[] {
  const base = input.basePathname.endsWith('/') ? input.basePathname : `${input.basePathname}/`;
  const prefix = base === '/' ? '' : base.slice(0, -1);
  const escaped = escapeRegex(prefix);
  const document: VercelRoute = input.noTrailingSlash
    ? { src: `^${escaped}/(.*[^/])$`, dest: `${prefix}/$1/index.html`, check: true }
    : { src: `^${escaped}/(.+)/$`, dest: `${prefix}/$1/index.html`, check: true };
  return [
    {
      src: `^${escaped}/.*$`,
      methods: ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      dest: `/${FUNCTION_NAME}`,
    },
    { handle: 'filesystem' },
    document,
    { src: `^${escaped}/.*$`, dest: `/${FUNCTION_NAME}` },
  ];
}

/** Writes `.vc-config.json` and `package.json` of the function directory (a Node.js function with the Web API). */
export function writeFunctionConfig(input: { functionDir: string; handler: string; runtime?: string }): void {
  writeFileSync(join(input.functionDir, 'package.json'), `${JSON.stringify({ type: 'module' })}\n`);
  writeFileSync(
    join(input.functionDir, '.vc-config.json'),
    `${JSON.stringify(
      {
        runtime: input.runtime ?? vercelNodeRuntime(),
        handler: input.handler,
        launcherType: 'Nodejs',
        useWebApi: true,
        supportsResponseStreaming: true,
        shouldAddHelpers: false,
      },
      null,
      2,
    )}\n`,
  );
}

/**
 * Copies the client build into `.vercel/output/static` (under the base pathname's directories), without the files
 * that configure other platforms or hold build metadata.
 */
export function copyStaticOutput(input: {
  clientDir: string;
  outputDir: string;
  basePathname: string;
}): string {
  const parts = input.basePathname.split('/').filter(Boolean);
  const target = join(input.outputDir, 'static', ...parts);
  rmSync(join(input.outputDir, 'static'), { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(input.clientDir, target, {
    recursive: true,
    filter: (src) => {
      const rel = relative(input.clientDir, src);
      if (!rel) return true;
      const first = rel.split(/[\\/]/)[0]!;
      return !PRIVATE_BUILD_FILES.includes(first) && !(rel === first && PLATFORM_FILES.has(first));
    },
  });
  return target;
}

/** Writes `.vercel/output/config.json` (version 3) with the Qwik routes. */
export function writeOutputConfig(input: {
  outputDir: string;
  basePathname: string;
  noTrailingSlash: boolean;
}): string {
  const file = join(input.outputDir, 'config.json');
  writeFileSync(file, `${JSON.stringify({ version: 3, routes: vercelRoutes(input) }, null, 2)}\n`);
  return file;
}
