import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseVersion } from '../../semver';
import { rel } from '../../util/fs';
import { type Check, fail, pass, skip, warn } from '../types';
import { maskSource } from './hono';
import { extensionlessImports, isEsmFile, vercelServerEntry } from './server-entry';

const REGISTRATION = "useHypDriv(app, { config }) from '@hypdriv/express'";

const ROUTE_METHODS = 'get|post|put|delete|patch|options|head|all|route';

export interface ExpressRegistration {
  /** What answers before the middleware: `.get()`, `express.static()`, `.use('/path', …)`; `null` when nothing. */
  answersBefore: string | null;
  /** `compression()` is registered after the middleware, on the same app. */
  compressionAfter: boolean;
}

/**
 * Where the Hypdriv middleware sits in an Express entry, or `null` when the source does not register it (or cannot be
 * read reliably). Express runs middleware in registration order: a route, a mounted router or app and a static file
 * server registered before `hypdriv()` answer without the Drivetrain, and a `compression()` registered after it
 * compresses the body before the pipeline reads it (the same rules `checkOrder()` applies at run time).
 */
export function expressRegistration(source: string): ExpressRegistration | null {
  const code = maskSource(source);
  if (code === null) return null;
  const use =
    /\b(?:useHypDriv\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*\.use\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?hypdriv\s*\()/.exec(
      code,
    );
  if (!use) return null;
  const app = ((use[1] ?? use[2]) as string).replace(/\$/g, '\\$');
  const before = code.slice(0, use.index);
  const after = code.slice(use.index + use[0].length);
  const route = new RegExp(`\\b${app}\\s*\\.(${ROUTE_METHODS})\\s*\\(\\s*['"\`]`).exec(before);
  const statics = new RegExp(
    `\\b${app}\\s*\\.use\\s*\\(\\s*(?:['"\`][^'"\`]*['"\`]\\s*,\\s*)?(?:express\\s*\\.\\s*static|serveStatic)\\s*\\(`,
  ).exec(before);
  const mounted = new RegExp(`\\b${app}\\s*\\.use\\s*\\(\\s*['"\`][^'"\`]*['"\`]\\s*,`).exec(before);
  const first = [
    route && { at: route.index, what: `.${route[1]}()` },
    statics && { at: statics.index, what: 'express.static()' },
    mounted && !statics && { at: mounted.index, what: ".use('/path', …)" },
  ]
    .filter((x): x is { at: number; what: string } => Boolean(x))
    .sort((a, b) => a.at - b.at)[0];
  return {
    answersBefore: first?.what ?? null,
    compressionAfter: new RegExp(`\\b${app}\\s*\\.use\\s*\\(\\s*compression\\s*\\(`).test(after),
  };
}

/** `true` when the source makes a Worker of an HTTP server: `httpServerHandler()` from `cloudflare:node`. */
export function usesHttpServerHandler(source: string): boolean {
  const code = maskSource(source);
  return /['"]cloudflare:node['"]/.test(source) && code !== null && /\bhttpServerHandler\s*\(/.test(code);
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const expressChecks: Check[] = [
  {
    id: 'express.integration',
    title: 'Hypdriv integration package',
    category: 'express',
    severity: 'error',
    frameworks: ['express'],
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.integrationInstalled)
        return fail(
          `Express ${f.version ?? ''} detected but @hypdriv/express is not installed (pnpm add @hypdriv/express).`,
        );
      return pass(`@hypdriv/express@${f.integrationInstalled} for Express ${f.version ?? ''}`.trim());
    },
  },
  {
    id: 'express.version',
    title: 'Express 5',
    category: 'express',
    severity: 'error',
    frameworks: ['express'],
    run(ctx) {
      const version = ctx.project.framework.version;
      const major = parseVersion(version?.replace(/^[\^~>=<\s]+/, ''))?.major ?? null;
      if (major === null) return skip(`Express version unknown (${version ?? 'not declared'}).`);
      if (major < 5)
        return fail(
          `Express ${version}: @hypdriv/express needs Express 5 (its router, async error handling and response API). Upgrade with the Express 5 migration guide.`,
        );
      return pass(`Express ${version}.`);
    },
  },
  {
    id: 'express.registered',
    title: 'Drivetrain registered in the Express app',
    category: 'express',
    severity: 'error',
    frameworks: ['express'],
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.configFile)
        return warn(`No Express entry found (src/app.ts, src/server.ts…); add ${REGISTRATION}.`);
      if (f.registered) return pass(`${rel(ctx.root, f.configFile)} references @hypdriv/express.`);
      return fail(
        `No Express entry references @hypdriv/express (looked first at ${rel(ctx.root, f.configFile)}); add ${REGISTRATION}.`,
      );
    },
  },
  {
    id: 'express.order',
    title: 'Middleware before routes, after compression',
    category: 'express',
    severity: 'error',
    frameworks: ['express'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !ctx.project.framework.registered) return skip('no entry registers Hypdriv.');
      const source = read(file);
      if (source === null) return skip(`${rel(ctx.root, file)} is not readable.`);
      const found = expressRegistration(source);
      if (!found) return skip('registration not recognised (a custom setup); check the order by hand.');
      const problems: string[] = [];
      if (found.answersBefore)
        problems.push(
          `${found.answersBefore} is registered before the Hypdriv middleware and answers without the Drivetrain; move useHypDriv() above routes, routers and static files.`,
        );
      if (found.compressionAfter)
        problems.push(
          'compression() is registered after the Hypdriv middleware: it compresses the body before the pipeline reads it, so CSP nonces cannot be injected; register compression() first.',
        );
      if (problems.length) return fail(`${rel(ctx.root, file)}: ${problems.join(' ')}`);
      return pass('the Hypdriv middleware comes before the routes (and after compression(), if any).');
    },
  },
  {
    id: 'express.vercel-entry',
    title: 'Vercel finds the Express app',
    category: 'express',
    severity: 'error',
    frameworks: ['express'],
    platforms: ['vercel'],
    run(ctx) {
      const entry = vercelServerEntry(ctx.root, 'express');
      if (!entry)
        return fail(
          "Vercel's Express preset finds no entry: it deploys the first of app, index, server (at the root or in src/, .js/.ts and friends) that imports express.",
        );
      const source = read(entry) ?? '';
      const code = maskSource(source) ?? source;
      const name = rel(ctx.root, entry);
      if (!/\bexport\s+default\b/.test(code) && !/\.listen\s*\(/.test(code))
        return fail(
          `${name} (the entry Vercel deploys) neither exports the app (export default app) nor calls listen(), so the Function has no handler.`,
        );
      const missing = isEsmFile(ctx.root, entry) ? extensionlessImports(source) : [];
      if (missing.length)
        return fail(
          `${name} imports ${missing.map((s) => `'${s}'`).join(', ')} without an extension: Vercel compiles each file to ESM as is and Node's loader needs './app.js'.`,
        );
      return pass(`Vercel deploys ${name}.`);
    },
  },
  {
    id: 'express.workers-entry',
    title: 'Worker entry serves the Express app',
    category: 'express',
    severity: 'error',
    frameworks: ['express'],
    platforms: ['cloudflare'],
    run(ctx) {
      const cfg = ctx.project.wrangler.config;
      if (!cfg) return skip('no wrangler config.');
      if (!cfg.compatibility_flags.some((flag) => flag === 'nodejs_compat' || flag === 'nodejs_compat_v2'))
        return fail(
          'Express runs on Workers through the nodejs_compat HTTP server: add "compatibility_flags": ["nodejs_compat"] to the wrangler config.',
        );
      if (!cfg.main)
        return fail('the wrangler config has no main; point it at the Worker entry (src/worker.ts).');
      const main = join(ctx.root, cfg.main);
      const source = read(main);
      if (source === null) return fail(`wrangler main ${cfg.main} does not exist.`);
      if (!usesHttpServerHandler(source))
        return fail(
          `${cfg.main} does not hand requests to the app: app.listen(8080); export default httpServerHandler({ port: 8080 }) with httpServerHandler from 'cloudflare:node'.`,
        );
      const app = ctx.project.framework.configFile;
      const appSource = app ? (read(app) ?? '') : '';
      if (/\bcompression\s*\(/.test(maskSource(appSource) ?? ''))
        return warn(
          `${rel(ctx.root, app as string)} registers compression(): the request a Worker sees advertises br/gzip whatever the client sent, and Cloudflare compresses at the edge. Keep compression() on the Node entry.`,
        );
      return pass(`${cfg.main} serves the app with httpServerHandler().`);
    },
  },
];
