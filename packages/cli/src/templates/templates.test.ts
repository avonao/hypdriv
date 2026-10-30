import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../wrangler-config';
import {
  defaultCompatibilityDate,
  devVarsExampleTemplate,
  headersTemplate,
  hypdrivConfigTemplate,
  instrumentationTemplate,
  proxyTemplate,
  workerName,
  workerTemplate,
  wranglerTemplate,
} from './index';

const example = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../../../examples/basic/${file}`, import.meta.url)), 'utf8');

describe('templates mirror examples/basic', () => {
  it.each([
    ['hypdriv.worker.ts', workerTemplate()],
    ['proxy.ts', proxyTemplate({ srcDir: false })],
    ['instrumentation.ts', instrumentationTemplate({ srcDir: false })],
    ['public/_headers', headersTemplate()],
    ['.dev.vars.example', devVarsExampleTemplate()],
  ])('%s', (file, content) => {
    expect(content).toBe(example(file));
  });

  it('keeps the proxy matcher identical to the one exported by hypdriv/proxy', async () => {
    const { matcher } = await import('@hypdriv/next/proxy');
    const literal = /matcher: \[([\s\S]*?)\]/.exec(proxyTemplate({ srcDir: false }))![1]!;
    const values = [...literal.matchAll(/'((?:\\.|[^'])*)'/g)].map((m) => m[1]!.replace(/\\\\/g, '\\'));
    expect(values).toEqual(matcher.matcher);
  });

  it('writes a wrangler.jsonc with the example core keys and valid JSONC', () => {
    const text = wranglerTemplate({
      name: 'shop',
      purser: false,
      srcDir: false,
      crons: ['0 9 * * 1'],
      compatibilityDate: defaultCompatibilityDate(new Date('2026-10-30T12:00:00Z')),
    });
    const parsed = parseJsonc(text) as Record<string, unknown>;
    const reference = parseJsonc(example('wrangler.jsonc')) as Record<string, unknown>;
    for (const key of ['main', 'compatibility_flags', 'assets', 'observability'])
      expect(parsed[key]).toEqual(reference[key]);
    expect(parsed).toMatchObject({
      name: 'shop',
      compatibility_date: '2026-10-01',
      triggers: { crons: ['0 9 * * 1'] },
      services: [{ binding: 'WORKER_SELF_REFERENCE', service: 'shop' }],
    });
  });

  it('writes a hypdriv.config.ts per platform', () => {
    const cf = hypdrivConfigTemplate({ name: 'shop', purser: true, srcDir: false });
    expect(cf).toContain("import { defineConfig } from 'hypdriv';");
    expect(cf).toContain("worker: { gzip: '3mb' }");
    expect(cf).toContain("tokens: 'lib/tokens.ts'");
    const vercel = hypdrivConfigTemplate({ name: 'shop', purser: false, srcDir: false, platform: 'vercel' });
    expect(vercel).not.toContain('worker:');
    expect(proxyTemplate({ srcDir: true })).toContain("from '../hypdriv.config'");
    expect(workerName('@Acme/Shop Front')).toBe('acme-shop-front');
  });
});
