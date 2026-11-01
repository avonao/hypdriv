import type { HypManifest } from '@hypdriv/core';
import type { AnalyzeSnapshot } from '../analyze/weights';
import type { LoadedConfig } from '../context';
import type { IO } from '../io';
import type { DeployPlatform, ProjectFramework, ProjectInfo } from '../project';

export type CheckCategory =
  | 'environment'
  | 'nextjs'
  | 'vite'
  | 'waku'
  | 'solid-start'
  | 'hono'
  | 'opennext'
  | 'wrangler'
  | 'vercel'
  | 'workers-compat'
  | 'hypdriv'
  | 'size'
  | 'security'
  | 'purser'
  | 'deps';

export const CHECK_CATEGORIES: CheckCategory[] = [
  'environment',
  'nextjs',
  'vite',
  'waku',
  'solid-start',
  'hono',
  'opennext',
  'wrangler',
  'vercel',
  'workers-compat',
  'hypdriv',
  'size',
  'security',
  'purser',
  'deps',
];

export const CATEGORY_TITLES: Record<CheckCategory, string> = {
  environment: 'Environment',
  nextjs: 'Next.js',
  vite: 'Vite host',
  waku: 'Waku host',
  'solid-start': 'SolidStart host',
  hono: 'Hono app',
  opennext: 'OpenNext',
  wrangler: 'Wrangler',
  vercel: 'Vercel',
  'workers-compat': 'Workers compatibility',
  hypdriv: 'Hypdriv',
  size: 'Size and startup',
  security: 'Security',
  purser: 'Purser CSS',
  deps: 'Dependencies',
};

export type CheckSeverity = 'error' | 'warn' | 'info';
export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface CheckFix {
  /** What the fix does (shown in reports and `--json`). */
  description: string;
  /** Applies the fix; absent when only manual steps exist. */
  apply?: () => Promise<void> | void;
}

export interface CheckResult {
  status: CheckStatus;
  message: string;
  details?: string[];
  fix?: CheckFix;
  /** A passing result that carries a recommendation (rendered with an info marker). */
  informational?: boolean;
}

export interface CheckContext {
  root: string;
  project: ProjectInfo;
  config: LoadedConfig;
  manifest: HypManifest | null;
  analyze: AnalyzeSnapshot | null;
  io: IO;
  now: Date;
  cliVersion: string;
  /** `--fix` was requested (checks may prepare fixes eagerly). */
  fix: boolean;
  /** Re-reads project state after a fix wrote files (set by the doctor command). */
  refresh?: () => void;
}

export interface Check {
  id: string;
  title: string;
  category: CheckCategory;
  /** Worst status this check produces when it finds something. */
  severity: CheckSeverity;
  /** Platforms the check applies to (default: all). Elsewhere it reports `skip`. */
  platforms?: DeployPlatform[];
  /** Frameworks the check applies to (default: all). Elsewhere it reports `skip`. */
  frameworks?: ProjectFramework[];
  run(ctx: CheckContext): Promise<CheckResult> | CheckResult;
}

export interface CheckReport {
  id: string;
  title: string;
  category: CheckCategory;
  severity: CheckSeverity;
  platforms: DeployPlatform[] | 'all';
  status: CheckStatus;
  message: string;
  details?: string[];
  fix?: string;
  fixable: boolean;
  fixed?: boolean;
  informational?: boolean;
  durationMs: number;
}

/** Convenience constructors. */
export const pass = (message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  status: 'pass',
  message,
  ...extra,
});
export const warn = (message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  status: 'warn',
  message,
  ...extra,
});
export const fail = (message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  status: 'fail',
  message,
  ...extra,
});
export const skip = (message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  status: 'skip',
  message,
  ...extra,
});
export const info = (message: string, extra: Partial<CheckResult> = {}): CheckResult => ({
  status: 'pass',
  message,
  informational: true,
  ...extra,
});
