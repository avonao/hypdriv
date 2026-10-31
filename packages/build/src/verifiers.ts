import type { Logger, PurserManifest, ResolvedConfig } from '@hypdriv/core';
import type { PurserVerifier, SecretsScanner } from './assemble';

interface PurserNodeModule {
  verifyBuild: (input: {
    projectDir: string;
    config: NonNullable<ResolvedConfig['purser']>;
    prerenderedHtml: Record<string, string> | (() => Promise<Record<string, string>>);
  }) => Promise<{
    ok: boolean;
    manifest: PurserManifest;
    errors: string[];
    warnings: string[];
    skipped: boolean;
  }>;
  detectPurser: (projectDir: string) => { installed: boolean; message?: string };
  collectPrerenderedHtml: (
    distDir: string,
    options?: { includeRsc?: boolean; log?: Logger },
  ) => Promise<Record<string, string>>;
}

interface PurserRuntimeModule {
  isPurserStylesheet: (css: string, layers?: { tokens: string; globals: string; atoms: string }) => boolean;
}

/**
 * Verifies the Purser stylesheet against every prerendered document and RSC payload (the unstyled-atom
 * guard), locates the CSS chunk Next.js emitted for it and returns the manifest section.
 */
export async function defaultPurserVerifier(): Promise<PurserVerifier | null> {
  let node: PurserNodeModule;
  let runtime: PurserRuntimeModule;
  try {
    node = (await import('@hypdriv/purser/node')) as unknown as PurserNodeModule;
    runtime = (await import('@hypdriv/purser')) as unknown as PurserRuntimeModule;
  } catch {
    return null;
  }
  if (typeof node.verifyBuild !== 'function' || typeof node.detectPurser !== 'function') return null;
  return async ({ html, documents, config, projectDir, distDir, cssAssets, readAsset, log }) => {
    const purser = config.purser;
    if (!purser || purser.enabled === false) return { manifest: null, ok: true, warnings: [] };
    const detected = node.detectPurser(projectDir);
    if (!detected.installed) {
      if (purser.enabled === true)
        return {
          manifest: null,
          ok: false,
          warnings: [],
          errors: [detected.message ?? 'Purser is enabled but @avonao/purser is not installed.'],
        };
      return { manifest: null, ok: true, warnings: [] };
    }
    const prerenderedHtml = async (): Promise<Record<string, string>> => {
      if (Object.keys(documents).length) return documents;
      if (typeof node.collectPrerenderedHtml !== 'function') return html;
      const collected = await node.collectPrerenderedHtml(distDir, { includeRsc: true, log });
      return Object.keys(collected).length ? collected : html;
    };
    const result = await node.verifyBuild({ projectDir, config: purser, prerenderedHtml });
    const manifest: PurserManifest = { ...result.manifest };
    if (typeof runtime.isPurserStylesheet === 'function') {
      const asset = cssAssets.find((href) => {
        const css = readAsset(href);
        return css !== null && runtime.isPurserStylesheet(css, purser.layers);
      });
      if (asset) {
        manifest.asset = asset;
        // Lightning CSS lowers lab() for older targets by duplicating declarations under @supports, which
        // leaves overridden declarations behind and breaks Purser's zero-override guarantee.
        const css = readAsset(asset) ?? '';
        if (/@supports\s*\(\s*color\s*:\s*lab\(/i.test(css)) {
          result.warnings.push(
            'The build lowered Purser\'s lab() colours with @supports fallbacks (browserslist targets older than Chrome/Edge 111, Firefox 113, Safari 16.4). The fallbacks are overridden declarations; set "browserslist": ["chrome >= 111", "edge >= 111", "firefox >= 113", "safari >= 16.4"] in package.json.',
          );
        }
      }
    }
    return { manifest, ok: result.ok, warnings: result.warnings, errors: result.ok ? [] : result.errors };
  };
}

export async function defaultSecretsScanner(): Promise<SecretsScanner | null> {
  try {
    const mod = (await import('@hypdriv/security/node')) as {
      scanSecrets?: (options: {
        dirs: string[];
        patterns: Array<{ id: string; pattern: RegExp; severity: 'error' | 'warn' }>;
        env: Record<string, string | undefined>;
        publicPrefixes: string[];
        envAllowlist: string[];
        minValueLength: number;
      }) => Promise<
        Array<{ id: string; file: string; line: number; severity: 'error' | 'warn'; snippet: string }>
      >;
    };
    if (!mod.scanSecrets) return null;
    return async ({ dirs, config }) => {
      const scan = config.security.secretsScan;
      if (!scan) return { findings: [], ok: true };
      const findings = await mod.scanSecrets!({
        dirs,
        patterns: scan.patterns,
        env: process.env,
        publicPrefixes: scan.publicPrefixes,
        envAllowlist: scan.envAllowlist,
        minValueLength: scan.minValueLength,
      });
      return { findings, ok: !findings.some((f) => f.severity === 'error') };
    };
  } catch {
    return null;
  }
}
