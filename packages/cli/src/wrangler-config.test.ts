import { describe, expect, it } from 'vitest';
import { WRANGLER_JSONC } from './__tests__/helpers';
import {
  declaredBindingNames,
  envBindingGaps,
  parseJsonc,
  parseTomlSubset,
  parseWranglerConfig,
  stripJsonc,
} from './wrangler-config';

describe('JSONC', () => {
  it('strips comments and trailing commas but keeps strings intact', () => {
    const text = `{ "a": "http://x // not a comment", /* c */ "b": [1, 2,], // trailing\n "c": { "d": "/* no */", }, }`;
    expect(parseJsonc(text)).toEqual({ a: 'http://x // not a comment', b: [1, 2], c: { d: '/* no */' } });
    expect(stripJsonc('"a\\"b" // x')).toBe('"a\\"b" ');
  });

  it('normalises a wrangler.jsonc document', () => {
    const cfg = parseWranglerConfig(WRANGLER_JSONC, 'jsonc');
    expect(cfg).toMatchObject({
      name: 'shop',
      main: '.open-next/worker.js',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      assets: { directory: '.open-next/assets', binding: 'ASSETS' },
    });
    expect(cfg.services[0]?.binding).toBe('WORKER_SELF_REFERENCE');
    expect(declaredBindingNames(cfg)).toEqual(expect.arrayContaining(['WORKER_SELF_REFERENCE', 'ASSETS']));
  });
});

describe('TOML subset', () => {
  const toml = `
name = "shop" # the worker
main = "hypdriv.worker.ts"
compatibility_date = "2026-10-01"
compatibility_flags = [
  "nodejs_compat",
  "global_fetch_strictly_public", # trailing comment
]
assets = { directory = ".open-next/assets", binding = "ASSETS" }

[observability]
enabled = true

[triggers]
crons = ["0 9 * * 1", "*/5 * * * *"]

[[kv_namespaces]]
binding = "HYPDRIV_KV"
id = "abc"

[[durable_objects.bindings]]
name = "HYPDRIV_LIMITER"
class_name = "HypDrivLimiter"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["HypDrivLimiter"]

[[analytics_engine_datasets]]
binding = "HYPDRIV_ANALYTICS"
dataset = "shop_vitals"

[vars]
LIMIT = 10
'QUOTED.KEY' = 'literal \\n'
`;

  it('parses tables, arrays of tables, inline tables and multi-line arrays', () => {
    const doc = parseTomlSubset(toml);
    expect(doc.name).toBe('shop');
    expect(doc.compatibility_flags).toEqual(['nodejs_compat', 'global_fetch_strictly_public']);
    expect(doc.assets).toEqual({ directory: '.open-next/assets', binding: 'ASSETS' });
    expect((doc.vars as Record<string, unknown>)['QUOTED.KEY']).toBe('literal \\n');
    const cfg = parseWranglerConfig(toml, 'toml');
    expect(cfg.observability?.enabled).toBe(true);
    expect(cfg.triggers?.crons).toEqual(['0 9 * * 1', '*/5 * * * *']);
    expect(cfg.kv_namespaces).toEqual([{ binding: 'HYPDRIV_KV', id: 'abc' }]);
    expect(cfg.durable_objects.bindings).toEqual([{ name: 'HYPDRIV_LIMITER', class_name: 'HypDrivLimiter' }]);
    expect(cfg.migrations[0]?.new_sqlite_classes).toEqual(['HypDrivLimiter']);
    expect(cfg.analytics_engine_datasets[0]?.dataset).toBe('shop_vitals');
    expect(cfg.vars.LIMIT).toBe(10);
  });
});

describe('environments', () => {
  const text = `{
    "name": "web", "main": "hypdriv.worker.ts", "compatibility_date": "2026-10-01",
    "assets": { "directory": ".open-next/assets", "binding": "ASSETS" },
    "vars": { "TOP": "1" },
    "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "web" }],
    "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "a" }],
    "durable_objects": { "bindings": [{ "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }] },
    "migrations": [{ "tag": "hypdriv-v1", "new_sqlite_classes": ["HypDrivChannel"] }],
    "env": {
      "app": {
        "vars": { "ENV": "app" },
        "services": [{ "binding": "WORKER_SELF_REFERENCE", "service": "web-app" }],
        "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "b" }],
        "durable_objects": { "bindings": [{ "name": "HYPDRIV_CHANNEL", "class_name": "HypDrivChannel" }] }
      },
      "bare": {},
      "named": { "name": "custom-name", "kv_namespaces": [{ "binding": "HYPDRIV_KV", "id": "c" }] }
    }
  }`;

  it('resolves an environment the way Wrangler does: inherited keys stay, bindings do not', () => {
    const bare = parseWranglerConfig(text, 'jsonc', 'bare');
    expect(bare.name).toBe('web-bare');
    expect(bare.main).toBe('hypdriv.worker.ts');
    expect(bare.compatibility_date).toBe('2026-10-01');
    expect(bare.assets?.binding).toBe('ASSETS');
    expect(bare.migrations).toHaveLength(1);
    expect(bare.services).toEqual([]);
    expect(bare.kv_namespaces).toEqual([]);
    expect(bare.durable_objects.bindings).toEqual([]);
    expect(bare.vars).toEqual({});
    expect(bare.env).toEqual({});
  });

  it("uses the environment's own bindings, vars and explicit name", () => {
    const app = parseWranglerConfig(text, 'jsonc', 'app');
    expect(app.name).toBe('web-app');
    expect(app.services[0]).toMatchObject({ service: 'web-app' });
    expect(app.kv_namespaces[0]).toMatchObject({ id: 'b' });
    expect(app.vars).toEqual({ ENV: 'app' });
    expect(parseWranglerConfig(text, 'jsonc', 'named').name).toBe('custom-name');
  });

  it('throws a readable error for an environment that does not exist', () => {
    expect(() => parseWranglerConfig(text, 'jsonc', 'nope')).toThrow(
      /no environment "nope" \(found: app, bare, named\)/,
    );
    expect(() => parseWranglerConfig('{"name":"x"}', 'jsonc', 'nope')).toThrow(/defines no environments/);
  });

  it('reports the binding kinds an environment loses', () => {
    const top = parseWranglerConfig(text, 'jsonc');
    expect(envBindingGaps(top)).toEqual([
      { env: 'bare', missing: ['services', 'kv_namespaces', 'durable_objects'] },
      { env: 'named', missing: ['services', 'durable_objects'] },
    ]);
  });
});
