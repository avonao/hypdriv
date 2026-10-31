/**
 * Lazy, structurally typed access to sibling packages. Every import happens on demand so the CLI
 * builds, tests and runs even when an optional sibling lacks an export; callers get `null` and print a
 * clear message instead of crashing.
 */
import type {
  CspDirectives,
  HypManifest,
  Logger,
  ResolvedConfig,
  ResolvedCsp,
  ResolvedPurser,
} from '@hypdriv/core';

export interface CspReportLike {
  documentUri: string;
  violatedDirective: string;
  effectiveDirective: string;
  blockedUri: string;
  disposition: 'enforce' | 'report';
  ts: number;
  [key: string]: unknown;
}

export interface SecurityModule {
  signAuditToken?: (
    secret: string,
    options: { host: string; ttlSeconds?: number; now?: number },
  ) => Promise<string>;
  signPurgeToken?: (
    secret: string,
    options: { host: string; ttlSeconds?: number; now?: number },
  ) => Promise<string>;
  parseCsp?: (header: string | null | undefined) => CspDirectives;
  serializeCsp?: (directives: CspDirectives) => string;
  buildCspHeader?: (input: {
    config: ResolvedCsp;
    mode: 'nonce' | 'hash' | 'unsafe-inline';
    nonce?: string;
    hashes?: { scriptHashes: string[]; styleHashes: string[] };
    development: boolean;
    reportTo?: string | null;
    origin?: string | null;
  }) => string;
  buildCspDirectives?: (input: {
    config: ResolvedCsp;
    mode: 'nonce' | 'hash' | 'unsafe-inline';
    nonce?: string;
    hashes?: { scriptHashes: string[]; styleHashes: string[] };
    development: boolean;
  }) => CspDirectives;
  suggestPolicy?: (
    reports: CspReportLike[],
    current: CspDirectives,
  ) => { directives: CspDirectives; additions: Array<{ directive: string; source: string; count: number }> };
  normalizeCspReport?: (body: unknown, meta?: { userAgent?: string; ts?: number }) => CspReportLike | null;
  extractNonce?: (directives: CspDirectives) => string | null;
  signing?: { signInternalRequest(request: Request, secret: string, now?: number): Promise<Request> };
}

export interface SecretFindingLike {
  id: string;
  file: string;
  line: number;
  severity: 'error' | 'warn';
  snippet: string;
}

export interface SecurityNodeModule {
  scanSecrets?: (options: {
    dirs: string[];
    patterns: Array<{ id: string; pattern: RegExp; severity: 'error' | 'warn' }>;
    env: Record<string, string | undefined>;
    publicPrefixes: string[];
    envAllowlist: string[];
    minValueLength: number;
  }) => Promise<SecretFindingLike[]>;
  formatFindings?: (findings: SecretFindingLike[]) => string;
}

export interface PurserBuildResultLike {
  css: string | null;
  diagnostics: Array<{
    severity: 'error' | 'warning';
    message: string;
    file?: string;
    line?: number;
    column?: number;
  }>;
  stats: { files: number; atoms: number; rules: number; keyframes: number; tokens: number } | null;
  written: boolean;
  outFile: string | null;
}

export interface PurserBridgeLike {
  outFile: string | null;
  tokensFile: string | null;
  build(): Promise<PurserBuildResultLike>;
  check(): Promise<PurserBuildResultLike>;
  watch(
    onResult?: (result: PurserBuildResultLike) => void,
    options?: { devDiagnostics?: boolean },
  ): Promise<{ close(): void }>;
  writeDevDiagnostics(result: PurserBuildResultLike): Promise<string>;
  formatDiagnostics?(result: PurserBuildResultLike): string;
  formatSummary?(result: PurserBuildResultLike): string;
  hasErrors?(result: PurserBuildResultLike): boolean;
}

export interface AuditPageLike {
  url: string;
  width: number;
  state: string;
  theme: string[];
  count: number;
  struck: Array<{ element: string; pseudo: string; property: string; sources: string[] }>;
  rules: number;
  skipped: string[];
  error?: string;
}

export interface AuditReportLike {
  ok: boolean;
  pages: AuditPageLike[];
  chrome: { path: string; version: string };
  durationMs: number;
  checks: number;
}

export interface PurserNodeModule {
  detectPurser?: (projectDir: string) => {
    installed: boolean;
    version: string | null;
    typescriptVersion: string | null;
    typescriptCompatible: boolean;
    tokensFile: string | null;
    message?: string | null;
  };
  createPurserBridge?: (options: {
    projectDir: string;
    config: ResolvedPurser;
    log?: Logger;
  }) => Promise<PurserBridgeLike>;
  auditOverrides?: (options: {
    urls: string[];
    widths: number[];
    states: Array<'default' | 'hover' | 'focus'>;
    chromePath?: string;
    projectDir?: string;
    timeoutMs?: number;
    themeClasses?: string[][];
    headers?: Record<string, string>;
    log?: Logger;
  }) => Promise<AuditReportLike>;
  formatAuditReport?: (report: AuditReportLike) => string;
  collectPrerenderedHtml?: (options: {
    projectDir: string;
    distDir?: string;
  }) => Promise<Record<string, string>>;
}

export interface NextAdapterModule {
  extractInlineScripts?: (html: string) => string[];
  extractInlineStyles?: (html: string) => string[];
  buildManifest?: (
    input: unknown,
  ) => Promise<{ manifest: HypManifest; failures: string[]; html: Record<string, string> }>;
}

async function tryImport<T>(specifier: string): Promise<T | null> {
  try {
    return (await import(specifier)) as T;
  } catch {
    return null;
  }
}

export const loadSecurity = (): Promise<SecurityModule | null> =>
  tryImport<SecurityModule>('@hypdriv/security');
export const loadSecurityNode = (): Promise<SecurityNodeModule | null> =>
  tryImport<SecurityNodeModule>('@hypdriv/security/node');
export const loadPurserNode = (): Promise<PurserNodeModule | null> =>
  tryImport<PurserNodeModule>('@hypdriv/purser/node');
export const loadNextAdapter = (): Promise<NextAdapterModule | null> =>
  tryImport<NextAdapterModule>('@hypdriv/next/adapter');

/** Message for a missing optional integration. */
export function missingExport(pkg: string, name: string): string {
  return `${pkg} does not export ${name} in this installation; update the @hypdriv packages to matching versions.`;
}

export type { ResolvedConfig };
