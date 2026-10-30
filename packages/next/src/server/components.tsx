import { HEADER, type HypManifest, loadConfig } from '@hypdriv/core';
import type { ReactElement } from 'react';
import { buildSpeculationRules, speculationScript } from '../shared/speculation';
import { devtoolsMeta } from './index';

async function requestHeaders(): Promise<Headers> {
  const mod = (await import('next/headers')) as { headers(): Promise<Headers> | Headers };
  return new Headers(await mod.headers());
}

async function manifestFromDisk(): Promise<HypManifest | null> {
  try {
    const mod = (await import('@hypdriv/core/node')) as { readManifestSync(dir: string): HypManifest | null; findProjectRoot(): string };
    return mod.readManifestSync(process.env.HYPDRIV_PROJECT_DIR ?? mod.findProjectRoot());
  } catch {
    return null;
  }
}

export interface SpeculationProps {
  /** Explicit rules; otherwise derived from the manifest for the current route. */
  rules?: Record<string, unknown>;
  /** HypDriv config (only `performance.speculation` is used); defaults apply when omitted. */
  config?: Parameters<typeof loadConfig>[0];
  /** Current pathname when it cannot be read from headers (static rendering). */
  pathname?: string;
}

/**
 * Server Component that renders a `<script type="speculationrules">` for the current route.
 * Renders nothing when the Worker already injected the rules at the edge.
 */
export async function Speculation(props: SpeculationProps = {}): Promise<ReactElement | null> {
  let headers: Headers | null = null;
  try {
    headers = await requestHeaders();
  } catch {
    headers = null;
  }
  if (headers?.get('x-hypdriv-speculation') === 'edge') return null;
  const nonce = headers?.get(HEADER.nonce) ?? undefined;
  let rules = props.rules;
  if (!rules) {
    const resolved = loadConfig(props.config ?? {});
    const spec = resolved.performance.speculation;
    if (!spec || spec.inject === 'off') return null;
    const manifest = await manifestFromDisk();
    const pathname = props.pathname ?? headers?.get('x-hypdriv-pathname') ?? '/';
    const built = buildSpeculationRules({ manifest: manifest ?? { speculation: { graph: {}, excluded: [] }, basePath: '' }, config: spec, pathname });
    if (!built) return null;
    rules = built as unknown as Record<string, unknown>;
  }
  const script = speculationScript(rules as never);
  // biome-ignore lint/security/noDangerouslySetInnerHtml: the JSON is produced by HypDriv, not user input.
  return <script type="speculationrules" nonce={nonce} dangerouslySetInnerHTML={{ __html: script }} />;
}

/** Server Component rendering the `<meta name="hypdriv:*">` tags the DevTools HUD and vitals reporter read. */
export async function HypDrivMeta(): Promise<ReactElement | null> {
  let meta: Record<string, string>;
  try {
    meta = await devtoolsMeta();
  } catch {
    return null;
  }
  const entries = Object.entries(meta);
  if (!entries.length) return null;
  return (
    <>
      {entries.map(([name, content]) => (
        <meta key={name} name={name} content={content} />
      ))}
    </>
  );
}
