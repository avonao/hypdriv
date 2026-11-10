import { readFileSync } from 'node:fs';
import { parseVersion } from '../../semver';
import { rel } from '../../util/fs';
import { type Check, fail, pass, skip, warn } from '../types';
import { maskSource } from './hono';
import { awaitsListenAtTopLevel, extensionlessImports, isEsmFile, vercelServerEntry } from './server-entry';

const REGISTRATION = "app.register(hypdriv, { config }) with hypdriv from '@hypdriv/fastify'";

export interface FastifyRegistration {
  /** The local name `@fastify/compress` is registered under, when it is registered before Hypdriv's plugin. */
  compressBefore: string | null;
}

/**
 * Where Hypdriv's plugin sits among the app's registrations, or `null` when the source does not register it (or
 * cannot be read reliably). Fastify runs `onSend` hooks in registration order: `@fastify/compress` registered
 * before Hypdriv compresses the payload before the pipeline reads it, so a CSP nonce cannot be injected.
 */
export function fastifyRegistration(source: string): FastifyRegistration | null {
  const code = maskSource(source);
  if (code === null) return null;
  const plugin = /\.register\s*\(\s*hypdriv\b/.exec(code);
  if (!plugin) return null;
  const compress =
    /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"]@fastify\/compress['"]/.exec(source)?.[1] ??
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]@fastify\/compress['"]\s*\)/.exec(
      source,
    )?.[1];
  if (!compress) return { compressBefore: null };
  const name = compress.replace(/\$/g, '\\$');
  const registered = new RegExp(`\\.register\\s*\\(\\s*${name}\\b`).exec(code);
  return { compressBefore: registered && registered.index < plugin.index ? compress : null };
}

function read(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const fastifyChecks: Check[] = [
  {
    id: 'fastify.integration',
    title: 'Hypdriv integration package',
    category: 'fastify',
    severity: 'error',
    frameworks: ['fastify'],
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.integrationInstalled)
        return fail(
          `Fastify ${f.version ?? ''} detected but @hypdriv/fastify is not installed (pnpm add @hypdriv/fastify).`,
        );
      return pass(`@hypdriv/fastify@${f.integrationInstalled} for Fastify ${f.version ?? ''}`.trim());
    },
  },
  {
    id: 'fastify.version',
    title: 'Fastify 5',
    category: 'fastify',
    severity: 'error',
    frameworks: ['fastify'],
    run(ctx) {
      const version = ctx.project.framework.version;
      const major = parseVersion(version?.replace(/^[\^~>=<\s]+/, ''))?.major ?? null;
      if (major === null) return skip(`Fastify version unknown (${version ?? 'not declared'}).`);
      if (major < 5)
        return fail(`Fastify ${version}: @hypdriv/fastify needs Fastify 5 (its hook and reply API).`);
      return pass(`Fastify ${version}.`);
    },
  },
  {
    id: 'fastify.registered',
    title: 'Plugin registered in the Fastify app',
    category: 'fastify',
    severity: 'error',
    frameworks: ['fastify'],
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.configFile)
        return warn(`No Fastify entry found (src/server.ts, src/app.ts…); add ${REGISTRATION}.`);
      if (f.registered) return pass(`${rel(ctx.root, f.configFile)} references @hypdriv/fastify.`);
      return fail(
        `No Fastify entry references @hypdriv/fastify (looked first at ${rel(ctx.root, f.configFile)}); add ${REGISTRATION}.`,
      );
    },
  },
  {
    id: 'fastify.order',
    title: '@fastify/compress after the plugin',
    category: 'fastify',
    severity: 'error',
    frameworks: ['fastify'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !ctx.project.framework.registered) return skip('no entry registers Hypdriv.');
      const source = read(file);
      if (source === null) return skip(`${rel(ctx.root, file)} is not readable.`);
      const found = fastifyRegistration(source);
      if (!found) return skip('registration not recognised (a custom setup); check the order by hand.');
      if (found.compressBefore)
        return fail(
          `${rel(ctx.root, file)} registers ${found.compressBefore} (@fastify/compress) before Hypdriv's plugin: its onSend hook compresses the payload before the pipeline reads it, so CSP nonces cannot be injected. Register it after the plugin.`,
        );
      return pass('no compression ahead of the plugin.');
    },
  },
  {
    id: 'fastify.vercel-entry',
    title: 'Vercel finds the Fastify server',
    category: 'fastify',
    severity: 'error',
    frameworks: ['fastify'],
    platforms: ['vercel'],
    run(ctx) {
      const entry = vercelServerEntry(ctx.root, 'fastify');
      if (!entry)
        return fail(
          "Vercel's Fastify preset finds no entry: it deploys the first of app, index, server (at the root or in src/, .js/.ts and friends) that imports fastify.",
        );
      const source = read(entry) ?? '';
      const code = maskSource(source) ?? source;
      const name = rel(ctx.root, entry);
      if (!/\.listen\s*\(/.test(code))
        return fail(
          `${name} (the entry Vercel deploys) does not call listen(): a Fastify instance is not a request handler, and Vercel serves the server listen() starts.`,
        );
      if (awaitsListenAtTopLevel(source))
        return fail(
          `${name} awaits listen() at the top level: Vercel starts the server only after the module has loaded, so the await never finishes. Call app.listen() without await.`,
        );
      const missing = isEsmFile(ctx.root, entry) ? extensionlessImports(source) : [];
      if (missing.length)
        return fail(
          `${name} imports ${missing.map((s) => `'${s}'`).join(', ')} without an extension: Vercel compiles each file to ESM as is and Node's loader needs './routes.js'.`,
        );
      return pass(`Vercel deploys ${name}.`);
    },
  },
  {
    id: 'fastify.workers',
    title: 'Fastify on Cloudflare Workers',
    category: 'fastify',
    severity: 'error',
    frameworks: ['fastify'],
    platforms: ['cloudflare'],
    run() {
      return fail(
        "Fastify does not run on Cloudflare Workers: its router (find-my-way) compiles handlers with new Function(), which workerd refuses ('Code generation from strings disallowed'). Deploy to Node or Vercel, or use @hypdriv/hono on Workers.",
      );
    },
  },
];
