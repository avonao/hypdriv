import { describe, expect, it } from 'vitest';
import { WRANGLER_JSONC } from './__tests__/helpers';
import {
  declaredBindingNames,
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
