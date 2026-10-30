import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HypDrivDevTools } from './index';
import {
  BuildPanel,
  CapabilitiesPanel,
  FlagsPanel,
  NavigationPanel,
  type PanelProps,
  PurserPanel,
  RequestPanel,
  VitalsPanel,
} from './panels';
import type { DevToolsData } from './readers';
import { LIGHT } from './styles';

const data: DevToolsData = {
  request: {
    entries: [
      { name: 'cache', dur: 1.2, desc: 'HIT' },
      { name: 'csp', desc: 'nonce' },
      { name: 'bot', desc: 'human' },
      { name: 'limit', desc: 'api:9/10' },
      { name: 'next', dur: 30 },
      { name: 'total', dur: 33 },
    ],
    total: 33,
    cache: 'HIT',
    csp: 'nonce',
    bot: 'human',
    limit: 'api:9/10',
    flags: '2',
  },
  vitals: {
    LCP: { name: 'LCP', value: 1800, rating: 'good', provisional: true },
    CLS: { name: 'CLS', value: 0.3, rating: 'poor', provisional: true },
  },
  navigations: [
    { url: '/blog', startTime: 1, duration: 40, entries: [{ name: 'cache', desc: 'MISS' }], cache: 'MISS' },
  ],
  flags: { beta: true, variant: 'b' },
  build: {
    build: 'b123',
    route: 'app:/blog/[slug]',
    runner: 'worker',
    deployment: null,
    requestId: null,
    locale: null,
    cache: null,
    csp: null,
    nextVersion: '16.4.3',
    hypdrivVersion: '0.1.0',
    extra: { custom: 'yes' },
  },
  purser: {
    ok: false,
    atoms: 12,
    builtAt: null,
    durationMs: 9,
    stylesheet: null,
    diagnostics: [{ severity: 'error', message: 'Unknown atom', file: 'app/page.tsx', line: 3 }],
  },
  state: {
    capabilities: { kv: true, channel: false, queues: ['jobs'] },
    summary: ['live channels: polling fallback'],
    config: { flags: { provider: 'static' } },
    details: { stages: { disable: [] } },
    runner: 'worker',
    development: true,
    buildId: 'b123',
    hypdrivVersion: '0.1.0',
    nextVersion: '16.4.3',
    raw: {},
  },
};

const panelProps: PanelProps = {
  theme: LIGHT,
  data,
  endpoint: '/_hypdriv/dev',
  purserReachable: true,
  stateLoading: false,
};

/** renderToString without React's text-boundary comments, so assertions can read adjacent text as one string. */
function render(element: Parameters<typeof renderToString>[0]): string {
  return renderToString(element).replace(/<!-- -->/g, '');
}

describe('HypDrivDevTools (SSR)', () => {
  it('renders the pill without crashing and without touching browser globals', () => {
    const html = renderToString(<HypDrivDevTools />);
    expect(html).toContain('data-hypdriv-devtools="pill"');
    expect(html).toContain('aria-label="Open HypDriv DevTools (Alt+Shift+H)"');
    expect(html).toContain('position:fixed');
    expect(html).toContain('z-index:2147483000');
    expect(html).toContain('bottom:12px');
    expect(html).toContain('right:12px');
  });

  it('respects position, hotkey and initialOpen props', () => {
    const html = renderToString(
      <HypDrivDevTools position="top-left" hotkey="Ctrl+K" initialOpen endpoint="/dev" />,
    );
    expect(html).toContain('data-hypdriv-devtools="panel"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('top:12px');
    expect(html).toContain('left:12px');
    expect(html).toContain('Ctrl+K');
    for (const tab of ['Request', 'Vitals', 'Navigation', 'Flags', 'Purser', 'Build', 'Capabilities'])
      expect(html).toContain(`>${tab}<`);
    expect(html).toContain('No Server-Timing entries');
    const noHotkey = renderToString(<HypDrivDevTools hotkey={false} />);
    expect(noHotkey).toContain('aria-label="Open HypDriv DevTools"');
  });
});

describe('panels', () => {
  it('Request panel shows stage rows and highlights cache/csp/bot/limit', () => {
    const html = render(<RequestPanel {...panelProps} />);
    expect(html).toContain('cache HIT');
    expect(html).toContain('csp nonce');
    expect(html).toContain('bot human');
    expect(html).toContain('limit api:9/10');
    expect(html).toContain('2 flags');
    expect(html).toContain('30.0 ms');
    expect(html).toContain('<table');
    expect(html).toContain('aria-label="Server-Timing entries"');
  });

  it('Vitals panel shows values with ratings and waits for missing ones', () => {
    const html = render(<VitalsPanel {...panelProps} />);
    expect(html).toContain('1800 ms');
    expect(html).toContain('0.300');
    expect(html).toContain('poor');
    expect(html).toContain('waiting');
  });

  it('Navigation, Flags, Build, Purser and Capabilities panels render their data and empty states', () => {
    expect(render(<NavigationPanel {...panelProps} />)).toContain('/blog');
    expect(render(<NavigationPanel {...panelProps} data={{ ...data, navigations: [] }} />)).toContain(
      'No RSC payload fetches',
    );
    const flags = render(<FlagsPanel {...panelProps} />);
    expect(flags).toContain('beta');
    expect(flags).toContain('>true<');
    expect(render(<FlagsPanel {...panelProps} data={{ ...data, flags: null }} />)).toContain('hypdriv:flags');
    const build = render(<BuildPanel {...panelProps} />);
    expect(build).toContain('b123');
    expect(build).toContain('app:/blog/[slug]');
    expect(build).toContain('custom');
    const purser = render(<PurserPanel {...panelProps} />);
    expect(purser).toContain('build failed');
    expect(purser).toContain('app/page.tsx:3');
    expect(purser).toContain('Unknown atom');
    expect(render(<PurserPanel {...panelProps} purserReachable={false} />)).toContain(
      'Purser bridge not running',
    );
    const caps = render(<CapabilitiesPanel {...panelProps} />);
    expect(caps).toContain('live channels: polling fallback');
    expect(caps).toContain('jobs');
    expect(caps).toContain('kv');
    expect(render(<CapabilitiesPanel {...panelProps} stateLoading />)).toContain('Loading');
    expect(render(<CapabilitiesPanel {...panelProps} data={{ ...data, state: null }} />)).toContain(
      'not available',
    );
  });
});
