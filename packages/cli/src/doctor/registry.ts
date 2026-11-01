import type { DeployPlatform, ProjectFramework } from '../project';
import { depsChecks } from './checks/deps';
import { environmentChecks } from './checks/environment';
import { experimentChecks } from './checks/experiments';
import { honoChecks } from './checks/hono';
import { hypdrivChecks } from './checks/hypdriv';
import { nextjsChecks } from './checks/nextjs';
import { nitroChecks } from './checks/nitro';
import { opennextChecks } from './checks/opennext';
import { openNextCacheChecks } from './checks/opennext-cache';
import { purserChecks } from './checks/purser';
import { securityChecks } from './checks/security';
import { sizeChecks } from './checks/size';
import { vercelChecks } from './checks/vercel';
import { viteChecks } from './checks/vite';
import { wakuChecks } from './checks/waku';
import { workersCompatChecks } from './checks/workers-compat';
import { wranglerChecks } from './checks/wrangler';
import type { Check } from './types';

/** Tags every check of a group with the platforms it applies to (keeps explicit tags). */
function onlyOn(platforms: DeployPlatform[], checks: Check[]): Check[] {
  return checks.map((c) => (c.platforms ? c : { ...c, platforms }));
}

/** Tags every check of a group with the frameworks it applies to (keeps explicit tags). */
function onlyFor(frameworks: ProjectFramework[], checks: Check[]): Check[] {
  return checks.map((c) => (c.frameworks ? c : { ...c, frameworks }));
}

/** Checks about Next.js, OpenNext and the `hypdriv.worker.ts` shell that do not apply to Vite hosts. */
const NEXT_ONLY = new Set([
  'wrangler.main',
  'wrangler.assets',
  'wrangler.run-worker-first',
  'wrangler.self-reference',
  'vercel.proxy-runtime',
  'vercel.cron-routes',
  'hypdriv.manifest-build-id',
  'hypdriv.worker-entry',
  'hypdriv.headers-file',
  'hypdriv.tsconfig-worker',
  'hypdriv.devtools',
  'compat.node-apis',
  'compat.process-exit',
  'compat.scan-coverage',
]);

function scoped(checks: Check[]): Check[] {
  return checks.map((c) => (NEXT_ONLY.has(c.id) && !c.frameworks ? { ...c, frameworks: ['next'] } : c));
}

/** Every doctor check, in report order. */
export const allChecks: Check[] = [
  ...environmentChecks,
  ...onlyFor(['next'], nextjsChecks),
  ...viteChecks,
  ...wakuChecks,
  ...nitroChecks,
  ...honoChecks,
  ...onlyFor(['next'], onlyOn(['cloudflare'], opennextChecks)),
  ...onlyFor(['next'], onlyOn(['cloudflare'], openNextCacheChecks)),
  ...scoped(onlyOn(['cloudflare'], wranglerChecks)),
  ...scoped(onlyOn(['vercel'], vercelChecks)),
  ...scoped(onlyOn(['cloudflare'], workersCompatChecks)),
  ...scoped(hypdrivChecks),
  ...experimentChecks,
  ...sizeChecks,
  ...securityChecks,
  ...purserChecks,
  ...depsChecks,
];

export function findCheck(id: string): Check | undefined {
  return allChecks.find((c) => c.id === id);
}
