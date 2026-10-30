import { cspHash, loadConfig } from '@hypdriv/core';
import { buildThemeScript } from '@hypdriv/purser';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { componentSpeculationRules, speculationScript } from '../shared/speculation';
import { HypDrivMeta, Speculation, ThemeScript } from './components';

const theme = { axes: { mode: { classes: { light: null, dark: 'dark' }, default: 'light' } } };

describe('prerender-safe head components', () => {
  it('<Speculation/> renders route-independent document rules without request data or nonce', () => {
    const html = renderToStaticMarkup(
      <Speculation
        config={{ performance: { speculation: { prerender: { eagerness: 'moderate' } } } }}
        basePath=""
      />,
    );
    expect(html).toMatch(/^<script type="speculationrules" data-hypdriv="speculation">/);
    expect(html).not.toContain('nonce');
    const spec = loadConfig({ performance: { speculation: { prerender: { eagerness: 'moderate' } } } })
      .performance.speculation!;
    const expected = speculationScript(componentSpeculationRules(spec, '')!);
    expect(JSON.parse(html.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''))).toEqual(
      JSON.parse(expected),
    );
  });

  it('<Speculation/> renders nothing when speculation is off', () => {
    expect(renderToStaticMarkup(<Speculation config={{ performance: { speculation: false } }} />)).toBe('');
  });

  it('<ThemeScript/> renders the deterministic fallback script without a nonce', async () => {
    const config = { purser: { theme } };
    const html = renderToStaticMarkup(<ThemeScript config={config} />);
    const script = buildThemeScript(loadConfig(config).purser!.theme!);
    expect(html).toBe(`<script data-hypdriv="theme">${script}</script>`);
    // The hash the build records is the hash of exactly this content.
    expect(await cspHash(script)).toMatch(/^'sha256-/);
  });

  it('<ThemeScript/> renders nothing without a theme', () => {
    expect(renderToStaticMarkup(<ThemeScript config={{}} />)).toBe('');
  });

  it('<HypDrivMeta/> renders build-level meta only', () => {
    const html = renderToStaticMarkup(<HypDrivMeta />);
    expect(html).toContain('name="hypdriv:version"');
    expect(html).toContain('name="hypdriv:devtools" content="/_hypdriv/dev"');
    expect(renderToStaticMarkup(<HypDrivMeta config={{ devtools: false }} />)).toBe('');
  });
});
