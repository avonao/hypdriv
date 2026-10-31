import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  mergeVercelRoutes,
  renderCloudflareHeaders,
  type StaticDocument,
  type StaticHeaderRule,
  staticHeaderRules,
  type VercelRoute,
} from '@hypdriv/build';
import type { HypManifest, Logger, ResolvedConfig } from '@hypdriv/core';
import { silentLogger } from '@hypdriv/core';

/** Files in a public directory that must never be served (build metadata). */
export const PRIVATE_BUILD_FILES = ['.vite', '.hypdriv'];

/**
 * Writes HypDriv's static rules into Cloudflare's `_headers` in the assets directory (merging with the
 * framework's and the user's rules) and keeps build metadata out of the upload through `.assetsignore`.
 */
export function writeCloudflareStatic(input: {
  assetsDir: string;
  rules: StaticHeaderRule[];
  log?: Logger;
}): { file: string; dropped: string[] } {
  const log = input.log ?? silentLogger;
  const file = join(input.assetsDir, '_headers');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const { content, dropped } = renderCloudflareHeaders(input.rules, existing);
  mkdirSync(input.assetsDir, { recursive: true });
  writeFileSync(file, content);
  ensureAssetsIgnore(input.assetsDir, PRIVATE_BUILD_FILES);
  if (dropped.length)
    log.warn(
      `hypdriv: ${dropped.length} static header rule(s) exceed Cloudflare's _headers limits (100 rules, 2,000 characters per line) and were left out: ${dropped.slice(0, 5).join(', ')}${dropped.length > 5 ? ', …' : ''}. Pages served through the Worker still get their CSP from the runtime.`,
    );
  return { file, dropped };
}

/** Adds entries to `.assetsignore` (Cloudflare uploads everything else in the assets directory). */
export function ensureAssetsIgnore(assetsDir: string, entries: string[]): void {
  const file = join(assetsDir, '.assetsignore');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(
    current
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
  let changed = false;
  for (const e of entries) {
    if (!lines.has(e)) {
      lines.add(e);
      changed = true;
    }
  }
  if (changed || !existsSync(file)) writeFileSync(file, `${[...lines].join('\n')}\n`);
}

interface VercelConfigJson {
  version: number;
  routes?: VercelRoute[];
  [key: string]: unknown;
}

/**
 * Inserts HypDriv's static rules into `.vercel/output/config.json` (before `handle: filesystem`, so they apply to
 * static files and function responses), removes build metadata from `static/`, and copies the manifest into
 * every Node function so the runtime can read it from its working directory.
 */
export function writeVercelStatic(input: {
  outputDir: string;
  rules: StaticHeaderRule[];
  manifestJson?: string;
  log?: Logger;
}): { file: string; functions: number } {
  const file = join(input.outputDir, 'config.json');
  const config: VercelConfigJson = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as VercelConfigJson)
    : { version: 3 };
  config.routes = mergeVercelRoutes(config.routes ?? [], input.rules);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  for (const name of PRIVATE_BUILD_FILES)
    rmSync(join(input.outputDir, 'static', name), { recursive: true, force: true });
  let functions = 0;
  if (input.manifestJson) {
    for (const dir of functionDirs(join(input.outputDir, 'functions'))) {
      const target = join(dir, '.hypdriv', 'manifest.json');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, input.manifestJson);
      functions++;
    }
  }
  return { file, functions };
}

function functionDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      // Symlinked functions share the target's directory.
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory() && e.name.endsWith('.func')) {
        if (existsSync(join(full, '.vc-config.json'))) out.push(full);
        continue;
      }
      if (e.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/** The static rules for a finished build. */
export function rulesFor(input: {
  config: ResolvedConfig;
  manifest: HypManifest;
  documents: StaticDocument[];
  immutablePrefixes: string[];
  /** SPA: every unknown path serves this document; its CSP goes into the catch-all rule instead. */
  spaShell?: StaticDocument;
}): StaticHeaderRule[] {
  const rules = staticHeaderRules({
    config: input.config,
    manifest: input.manifest,
    documents: input.documents.filter((d) => !input.spaShell || d.pathname !== input.spaShell.pathname),
    immutablePrefixes: input.immutablePrefixes,
  });
  if (!input.spaShell) return rules;
  // Deep links of a single-page app only match the catch-all: it carries the shell's CSP, and the other rules
  // detach it (`! content-security-policy`) so no path ends up with two policies.
  const shell = staticHeaderRules({
    config: input.config,
    manifest: input.manifest,
    documents: [input.spaShell],
    immutablePrefixes: [],
    trailingSlashVariants: false,
  }).find((r) => r.path === input.spaShell!.pathname);
  const catchAll = rules.find((r) => r.path === '/*');
  if (shell && catchAll) {
    // Content-hashed assets match the catch-all too: they need neither the document policy nor its hints.
    for (const rule of rules) {
      if (rule.path !== '/*' && rule.path.endsWith('/*'))
        rule.unset = [...new Set([...(rule.unset ?? []), ...Object.keys(shell.set)])];
    }
    const cspKeys = Object.keys(shell.set).filter(
      (k) => k.startsWith('content-security-policy') || k === 'reporting-endpoints' || k === 'x-hypdriv-csp',
    );
    for (const k of Object.keys(shell.set)) catchAll.set[k] = shell.set[k]!;
    for (const rule of rules) {
      if (rule === catchAll) continue;
      const own = Object.keys(rule.set);
      const detach = cspKeys.filter((k) => !own.includes(k) || k.startsWith('content-security-policy'));
      if (own.some((k) => k.startsWith('content-security-policy')))
        rule.unset = [...new Set([...(rule.unset ?? []), ...detach])];
    }
  }
  return rules;
}
