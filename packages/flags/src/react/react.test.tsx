import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Flag, FlagsProvider, useFlag, useFlags } from './index';

function Show({ name, fallback }: { name: string; fallback?: string }) {
  const value = useFlag(name, fallback);
  return <span data-flag={name}>{String(value)}</span>;
}

function All() {
  const flags = useFlags();
  return <code>{JSON.stringify(flags)}</code>;
}

describe('@hypdriv/flags/react', () => {
  it('provides values to useFlag and useFlags during SSR', () => {
    const html = renderToString(
      <FlagsProvider values={{ beta: true, theme: 'dark', limit: 3 }}>
        <Show name="beta" />
        <Show name="theme" />
        <Show name="limit" />
        <All />
      </FlagsProvider>,
    );
    expect(html).toContain('<span data-flag="beta">true</span>');
    expect(html).toContain('<span data-flag="theme">dark</span>');
    expect(html).toContain('<span data-flag="limit">3</span>');
    expect(html).toContain('{&quot;beta&quot;:true,&quot;theme&quot;:&quot;dark&quot;,&quot;limit&quot;:3}');
  });

  it('falls back without a provider or for unknown flags', () => {
    expect(renderToString(<Show name="missing" fallback="nope" />)).toContain('>nope<');
    expect(renderToString(<Show name="missing" />)).toContain('>undefined<');
    expect(renderToString(<All />)).toContain('{}');
    expect(
      renderToString(
        <FlagsProvider values={null}>
          <All />
        </FlagsProvider>,
      ),
    ).toContain('{}');
  });

  it('nested providers override outer values', () => {
    const html = renderToString(
      <FlagsProvider values={{ a: 'outer', b: 'outer' }}>
        <FlagsProvider values={{ a: 'inner' }}>
          <Show name="a" />
          <Show name="b" fallback="gone" />
        </FlagsProvider>
      </FlagsProvider>,
    );
    expect(html).toContain('>inner<');
    expect(html).toContain('>gone<');
  });

  it('<Flag> renders children when truthy, fallback otherwise, and supports value matching', () => {
    const html = renderToString(
      <FlagsProvider values={{ on: true, off: false, variant: 'b', zero: 0 }}>
        <Flag name="on">
          <i>on</i>
        </Flag>
        <Flag name="off" fallback={<b>off-fallback</b>}>
          <i>off</i>
        </Flag>
        <Flag name="variant" value="b">
          <i>variant-b</i>
        </Flag>
        <Flag name="variant" value="a" fallback={<b>not-a</b>}>
          <i>variant-a</i>
        </Flag>
        <Flag name="zero">
          <i>zero</i>
        </Flag>
        <Flag name="missing">
          <i>missing</i>
        </Flag>
      </FlagsProvider>,
    );
    expect(html).toContain('<i>on</i>');
    expect(html).not.toContain('<i>off</i>');
    expect(html).toContain('<b>off-fallback</b>');
    expect(html).toContain('<i>variant-b</i>');
    expect(html).toContain('<b>not-a</b>');
    expect(html).not.toContain('<i>zero</i>');
    expect(html).not.toContain('<i>missing</i>');
  });
});
