/**
 * Reading `cloudflare.config.ts`, the programmatic Worker configuration of the `cf` CLI (`import { defineConfig,
 * bindings, triggers, exports } from 'cf/config'`), into the same normalised shape Hypdriv reads from
 * `wrangler.jsonc` (`WranglerConfig`), so doctor and init understand both.
 *
 * The file is a program, not data: it is evaluated in a child Node process (isolated from the CLI, with a timeout)
 * where `cf/config` resolves to a small recording implementation and `import … with { type: 'cf-worker' }` to a
 * stub that records the entry file. The Worker's own code is never executed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
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

/**
 * Runs in the child process: `cf/config` becomes a recorder; `with { type: 'cf-worker' }` imports become stubs (also
 * when the entry is not built yet). The result goes to a file, never to stdout, so a config that logs (dotenv,
 * `console.log`) cannot corrupt it, and the process exits explicitly so a lingering timer or socket cannot hold it.
 */
const EVALUATOR = `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const file = process.env.HYPDRIV_CF_FILE;
const out = process.env.HYPDRIV_CF_OUT;
const CF = \`const make = (ns) => new Proxy({}, { get: (_, kind) => (...args) => ({ __hypdriv: ns, kind, args }) });
export const bindings = make('binding'), triggers = make('trigger'), exports = make('export');
export const defineConfig = (config) => config, defineWorker = (config) => config, defineContainer = (config) => config;\`;
const finish = (result) => {
  writeFileSync(out, JSON.stringify(result, (key, value) => (typeof value === 'function' ? undefined : value)));
  process.exit(0);
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cf/config') return { url: 'hypdriv-virtual:cf/config', shortCircuit: true, format: 'module' };
    if (context.importAttributes && context.importAttributes.type === 'cf-worker') {
      let url;
      try {
        url = next(specifier, context).url;
      } catch (err) {
        // The entry is usually a build output (.open-next/worker.js) that does not exist yet.
        if (!/^(\\.{0,2}\\/|file:)/.test(specifier) || !context.parentURL) throw err;
        url = new URL(specifier, context.parentURL).href;
      }
      return { url: url + '?cf-worker', format: 'module', shortCircuit: true };
    }
    return next(specifier, context);
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
const context = { mode: process.env.HYPDRIV_CF_MODE || undefined, isPreview: false };
// cf accepts a value, a promise or a function of the context wherever a config goes (the file and \`worker\`).
const resolveInput = async (value) => (typeof value === 'function' ? await value(context) : await value);
try {
  const mod = await import(pathToFileURL(file).href);
  let config = await resolveInput(mod.default);
  if (config && typeof config === 'object' && 'worker' in config) config = { ...config, worker: await resolveInput(config.worker) };
  finish({ ok: true, value: config === undefined ? null : config });
} catch (err) {
  const message = err && err.message ? String(err.message) : String(err);
  finish({ ok: false, error: (err && err.code ? '[' + err.code + '] ' : '') + message });
}
`;

/** Node strips TypeScript types by default from 22.18; `cf` itself needs 22.18 or later. */
export function canEvaluateCloudflareConfig(): boolean {
  const features = process.features as { typescript?: string | false };
  return typeof features.typescript === 'string' && features.typescript !== '';
}

export interface EvaluateOptions {
  /** The `mode` passed to a function-form `defineConfig` (cf's `--mode`; undefined in Wrangler). */
  mode?: string | null;
  /**
   * Environment for the child process. The default is the CLI's environment without credentials (variables named
   * like a token, secret, password or key): evaluating a config needs account and resource ids, never a login.
   */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

const CREDENTIAL_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|PRIVATE_?KEY|AUTH)(?:_|$)/i;

/** The environment the config is evaluated with: the CLI's, minus anything that looks like a credential. */
function evaluationEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (!CREDENTIAL_NAME.test(key)) env[key] = value;
  return env;
}

interface Evaluation {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Evaluates the file and returns its default export as plain JSON (builder calls stay `{__hypdriv, kind, args}`). */
export function evaluateCloudflareConfig(file: string, options: EvaluateOptions = {}): unknown {
  if (!canEvaluateCloudflareConfig())
    throw new Error(
      `reading ${relativeToCwd(file)} needs Node 22.18 or later (it is a TypeScript program; the cf CLI requires the same)`,
    );
  const dir = mkdtempSync(join(tmpdir(), 'hypdriv-cf-'));
  const out = join(dir, 'result.json');
  try {
    const env: NodeJS.ProcessEnv = {
      ...(options.env ?? evaluationEnv(process.env)),
      HYPDRIV_CF_FILE: file,
      HYPDRIV_CF_OUT: out,
      NODE_NO_WARNINGS: '1',
    };
    if (options.mode) env.HYPDRIV_CF_MODE = options.mode;
    else delete env.HYPDRIV_CF_MODE;
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', EVALUATOR], {
      cwd: dirname(file),
      env,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 20_000,
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    let result: Evaluation | null = null;
    try {
      result = JSON.parse(readFileSync(out, 'utf8')) as Evaluation;
    } catch {
      // The child never reached the end: timed out, crashed or its top-level await never settled.
    }
    if (result?.ok) return result.value ?? null;
    if (result) throw new Error(result.error || `evaluating ${file} failed`);
    const error = run.error as (Error & { code?: string }) | undefined;
    if (error?.code === 'ETIMEDOUT' || run.signal === 'SIGTERM')
      throw new Error(`evaluating ${file} timed out`);
    if (run.status === 13)
      throw new Error(`evaluating ${file} never finished (a top-level await that never settles)`);
    throw new Error(stderrSummary(run.stderr) || error?.message || `evaluating ${file} failed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const relativeToCwd = (file: string): string => {
  const cwd = process.cwd();
  return file.startsWith(`${cwd}/`) || file.startsWith(`${cwd}\\`) ? file.slice(cwd.length + 1) : file;
};

/** The message lines of a crash dump: the stack frames, the source excerpt and the Node banner are dropped. */
function stderrSummary(stderr: string | null | undefined): string {
  const lines = String(stderr ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('at ') && !l.startsWith('Node.js v') && !/^[\^~\s]+$/.test(l));
  const message = lines.filter((l) => /error/i.test(l));
  return (message.length ? message : lines).slice(0, 3).join(' ');
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

/** The `main` of a wrangler document: the entry relative to the config's directory, with forward slashes. */
function entryToMain(configDir: string, entryPath: string): string {
  // A Windows path (`C:\app\src\worker.ts`) is absolute for win32 only; each flavour relates its own paths.
  const flavour = win32.isAbsolute(entryPath) && !posix.isAbsolute(entryPath) ? win32 : posix;
  const relativePath = flavour.isAbsolute(entryPath) ? flavour.relative(configDir, entryPath) : entryPath;
  return relativePath.replace(/\\/g, '/').replace(/^(?!\.{1,2}\/)/, './');
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
  if (entryPath) doc.main = entryToMain(configDir, entryPath);
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
  const renamed: Array<{ from: string; to: string }> = [];
  for (const [className, call] of Object.entries(obj(worker.exports) ?? {})) {
    if (!isCall(call) || call.kind !== 'durableObject') continue;
    const a = firstArg(call);
    // `state` is "created" (the default, a live class), "deleted", "renamed" (with `renamed_to`), "transferred"
    // (a tombstone) or "expecting-transfer" (a live class receiving one from another Worker).
    if (a.state === 'deleted') deleted.push(className);
    else if (a.state === 'renamed') {
      const to = str(a.renamedTo) ?? str(a.renamed_to);
      if (to) renamed.push({ from: className, to });
    } else if (a.state === 'transferred') continue;
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
  if (sqlite.length || legacy.length || deleted.length || renamed.length)
    doc.migrations = [
      {
        tag: 'cloudflare.config.ts',
        ...(legacy.length ? { new_classes: legacy } : {}),
        ...(sqlite.length ? { new_sqlite_classes: sqlite } : {}),
        ...(deleted.length ? { deleted_classes: deleted } : {}),
        ...(renamed.length ? { renamed_classes: renamed } : {}),
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
