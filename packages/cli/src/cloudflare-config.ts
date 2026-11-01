/**
 * Reading `cloudflare.config.ts`, the programmatic Worker configuration of the `cf` CLI (`import { defineConfig,
 * bindings, triggers, exports } from 'cf/config'`), into the same normalised shape Hypdriv reads from
 * `wrangler.jsonc` (`WranglerConfig`), so doctor and init understand both.
 *
 * The file is a program, not data: it is evaluated in a child Node process (isolated from the CLI, with a timeout)
 * where `cf/config` resolves to a small recording implementation and `import … with { type: 'cf-worker' }` to a
 * stub that records the entry file. The Worker's own code is never executed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { type JsonValue, normalizeWranglerConfig, type WranglerConfig } from './wrangler-config';

export const CLOUDFLARE_CONFIG_FILES = [
  'cloudflare.config.ts',
  'cloudflare.config.mts',
  'cloudflare.config.js',
  'cloudflare.config.mjs',
] as const;

/** The first `cloudflare.config.*` in a directory, or null. */
export function findCloudflareConfig(dir: string): string | null {
  for (const name of CLOUDFLARE_CONFIG_FILES) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export function isCloudflareConfigFile(file: string): boolean {
  return /(^|[\\/])cloudflare\.config\.(m?ts|m?js)$/.test(file);
}

/** A builder call recorded by the `cf/config` stand-in (`bindings.kv(...)`, `triggers.scheduled(...)`, …). */
interface Call {
  __hypdriv: 'binding' | 'trigger' | 'export';
  kind: string;
  args: unknown[];
}

const isCall = (value: unknown): value is Call =>
  typeof value === 'object' && value !== null && '__hypdriv' in value && 'kind' in value && 'args' in value;

/** Runs in the child process: `cf/config` becomes a recorder; `with { type: 'cf-worker' }` imports become stubs. */
const EVALUATOR = `
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const file = process.env.HYPDRIV_CF_FILE;
const CF = \`const make = (ns) => new Proxy({}, { get: (_, kind) => (...args) => ({ __hypdriv: ns, kind, args }) });
export const bindings = make('binding'), triggers = make('trigger'), exports = make('export');
export const defineConfig = (config) => config, defineWorker = (config) => config, defineContainer = (config) => config;\`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cf/config') return { url: 'hypdriv-virtual:cf/config', shortCircuit: true, format: 'module' };
    const resolved = next(specifier, context);
    if (context.importAttributes && context.importAttributes.type === 'cf-worker')
      return { ...resolved, url: resolved.url + '?cf-worker', shortCircuit: true };
    return resolved;
  },
  load(url, context, next) {
    if (url === 'hypdriv-virtual:cf/config') return { format: 'module', source: CF, shortCircuit: true };
    if (url.endsWith('?cf-worker'))
      return {
        format: 'module',
        source: 'export const __cfWorker = ' + JSON.stringify(fileURLToPath(url.slice(0, -10))) + ';',
        shortCircuit: true,
      };
    return next(url, context);
  },
});
const mod = await import(pathToFileURL(file).href);
let config = mod.default;
if (typeof config === 'function') config = config({ mode: process.env.HYPDRIV_CF_MODE || undefined, isPreview: false });
config = await config;
process.stdout.write(JSON.stringify(config === undefined ? null : config, (key, value) => (typeof value === 'function' ? undefined : value)));
`;

/** Node strips TypeScript types by default from 22.18; `cf` itself needs 22.18 or later. */
export function canEvaluateCloudflareConfig(): boolean {
  const features = process.features as { typescript?: string | false };
  return typeof features.typescript === 'string' && features.typescript !== '';
}

export interface EvaluateOptions {
  /** The `mode` passed to a function-form `defineConfig` (cf's `--mode`; undefined in Wrangler). */
  mode?: string | null;
  /** Environment for the child process (default: the CLI's). */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** Evaluates the file and returns its default export as plain JSON (builder calls stay `{__hypdriv, kind, args}`). */
export function evaluateCloudflareConfig(file: string, options: EvaluateOptions = {}): unknown {
  if (!canEvaluateCloudflareConfig())
    throw new Error(
      `reading ${relative(process.cwd(), file) || file} needs Node 22.18 or later (it is a TypeScript program; the cf CLI requires the same)`,
    );
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    HYPDRIV_CF_FILE: file,
    NODE_NO_WARNINGS: '1',
  };
  if (options.mode) env.HYPDRIV_CF_MODE = options.mode;
  else delete env.HYPDRIV_CF_MODE;
  let output: string;
  try {
    output = execFileSync(process.execPath, ['--input-type=module', '-e', EVALUATOR], {
      cwd: dirname(file),
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { stderr?: string | Buffer; killed?: boolean; code?: string; message: string };
    if (e.code === 'ETIMEDOUT' || e.killed) throw new Error(`evaluating ${file} timed out`);
    const stderr = String(e.stderr ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('at ') && !l.startsWith('Node.js v'));
    throw new Error(stderr.slice(0, 3).join(' ') || e.message);
  }
  return JSON.parse(output) as unknown;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The name of a Worker reference: a string, or a `defineWorker()` object. */
function workerName(ref: unknown): string | undefined {
  return str(ref) ?? str(obj(ref)?.name);
}

function firstArg(call: Call): Obj {
  return obj(call.args[0]) ?? {};
}

/** Converts the evaluated `cloudflare.config.ts` into a wrangler-shaped document. */
export function cloudflareConfigToWrangler(value: unknown, configDir: string): Record<string, JsonValue> {
  const root = obj(value);
  const worker = obj(root?.worker);
  const doc: Record<string, JsonValue> = {};
  if (!worker) return doc;

  const name = str(worker.name);
  if (name) doc.name = name;

  const entry = worker.entrypoint;
  const entryPath = str(entry) ?? str(obj(entry)?.__cfWorker);
  if (entryPath) {
    const relativePath = entryPath.startsWith('/') ? relative(configDir, entryPath) : entryPath;
    doc.main = relativePath.replace(/\\/g, '/').replace(/^(?![./])/, './');
  }
  if (str(worker.compatibilityDate)) doc.compatibility_date = worker.compatibilityDate as string;
  if (Array.isArray(worker.compatibilityFlags))
    doc.compatibility_flags = worker.compatibilityFlags.filter((f): f is string => typeof f === 'string');
  if (typeof worker.workersDev === 'boolean') doc.workers_dev = worker.workersDev;

  const observability = obj(worker.observability);
  if (observability) {
    const logs = obj(observability.logs);
    doc.observability = {
      ...(typeof observability.enabled === 'boolean' ? { enabled: observability.enabled } : {}),
      ...(logs ? { logs: logs as { [k: string]: JsonValue } } : {}),
    };
  }

  const assets: { [k: string]: JsonValue } = {};
  const assetOptions = obj(worker.assets);
  if (assetOptions) {
    if (assetOptions.runWorkerFirst !== undefined)
      assets.run_worker_first = assetOptions.runWorkerFirst as JsonValue;
    if (str(assetOptions.htmlHandling)) assets.html_handling = assetOptions.htmlHandling as string;
    if (str(assetOptions.notFoundHandling))
      assets.not_found_handling = assetOptions.notFoundHandling as string;
  }

  const vars: { [k: string]: JsonValue } = {};
  const kv: JsonValue[] = [];
  const r2: JsonValue[] = [];
  const d1: JsonValue[] = [];
  const services: JsonValue[] = [];
  const durable: JsonValue[] = [];
  const producers: JsonValue[] = [];
  const consumers: JsonValue[] = [];
  const analytics: JsonValue[] = [];
  const ratelimits: JsonValue[] = [];
  const crons: string[] = [];

  for (const [binding, call] of Object.entries(obj(worker.env) ?? {})) {
    if (!isCall(call)) {
      // A plain value is not a binding builder; cf ignores nothing silently, but there is nothing to infer.
      continue;
    }
    const a = firstArg(call);
    switch (call.kind) {
      case 'text':
      case 'json':
        vars[binding] = (call.args[0] ?? null) as JsonValue;
        break;
      case 'assets':
        assets.binding = binding;
        break;
      case 'kv':
        kv.push({
          binding,
          ...(str(a.id) ? { id: a.id as string } : {}),
          ...(str(a.title) ? { title: a.title as string } : {}),
        });
        break;
      case 'r2':
        r2.push({ binding, bucket_name: str(a.name) ?? str(a.bucketName) ?? str(call.args[0]) ?? '' });
        break;
      case 'd1':
        d1.push({
          binding,
          database_name: str(a.name) ?? '',
          ...(str(a.id) ? { database_id: a.id as string } : {}),
        });
        break;
      case 'queue':
        producers.push({ binding, queue: str(a.name) ?? '' });
        break;
      case 'worker':
        services.push({
          binding,
          service: workerName(a.worker) ?? '',
          ...(str(a.exportName) ? { entrypoint: a.exportName as string } : {}),
        });
        break;
      case 'durableObject': {
        const target = workerName(a.worker);
        durable.push({
          name: binding,
          class_name: str(a.exportName) ?? '',
          ...(target && target !== name ? { script_name: target } : {}),
        });
        break;
      }
      case 'ai':
        doc.ai = { binding };
        break;
      case 'images':
        doc.images = { binding };
        break;
      default:
        if (/analytics/i.test(call.kind))
          analytics.push({ binding, dataset: str(a.dataset) ?? str(a.name) ?? str(call.args[0]) ?? '' });
        else if (/rate/i.test(call.kind)) ratelimits.push({ binding, name: binding });
    }
  }

  const triggers = Array.isArray(worker.triggers) ? worker.triggers : [];
  for (const call of triggers) {
    if (!isCall(call)) continue;
    const a = firstArg(call);
    if (call.kind === 'scheduled' && str(a.schedule)) crons.push(a.schedule as string);
    if (call.kind === 'queue' && str(a.name)) consumers.push({ queue: a.name as string });
  }

  const sqlite: string[] = [];
  const legacy: string[] = [];
  const deleted: string[] = [];
  for (const [className, call] of Object.entries(obj(worker.exports) ?? {})) {
    if (!isCall(call) || call.kind !== 'durableObject') continue;
    const a = firstArg(call);
    if (a.state === 'deleted') deleted.push(className);
    else if (a.storage === 'legacy-kv') legacy.push(className);
    else sqlite.push(className);
  }

  if (Object.keys(assets).length) doc.assets = assets;
  if (Object.keys(vars).length) doc.vars = vars;
  if (kv.length) doc.kv_namespaces = kv;
  if (r2.length) doc.r2_buckets = r2;
  if (d1.length) doc.d1_databases = d1;
  if (services.length) doc.services = services;
  if (durable.length) doc.durable_objects = { bindings: durable };
  if (analytics.length) doc.analytics_engine_datasets = analytics;
  if (ratelimits.length) doc.ratelimits = ratelimits;
  if (producers.length || consumers.length) doc.queues = { producers, consumers };
  if (crons.length) doc.triggers = { crons };
  if (sqlite.length || legacy.length || deleted.length)
    doc.migrations = [
      {
        tag: 'cloudflare.config.ts',
        ...(legacy.length ? { new_classes: legacy } : {}),
        ...(sqlite.length ? { new_sqlite_classes: sqlite } : {}),
        ...(deleted.length ? { deleted_classes: deleted } : {}),
      },
    ];
  return doc;
}

/** Reads a `cloudflare.config.*` file into the normalised Wrangler shape. Throws with a readable message. */
export function readCloudflareConfig(file: string, options: EvaluateOptions = {}): WranglerConfig {
  const evaluated = evaluateCloudflareConfig(file, options);
  if (!obj(evaluated)?.worker)
    throw new Error(
      'the file has no `worker` (account-level configuration only); Hypdriv reads the Worker settings from it',
    );
  return normalizeWranglerConfig(cloudflareConfigToWrangler(evaluated, dirname(file)));
}
