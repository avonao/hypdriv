import type { DeployPlatform } from '../project';
import { depsChecks } from './checks/deps';
import { environmentChecks } from './checks/environment';
import { hypdrivChecks } from './checks/hypdriv';
import { nextjsChecks } from './checks/nextjs';
import { opennextChecks } from './checks/opennext';
import { openNextCacheChecks } from './checks/opennext-cache';
import { purserChecks } from './checks/purser';
import { securityChecks } from './checks/security';
import { sizeChecks } from './checks/size';
import { vercelChecks } from './checks/vercel';
import { workersCompatChecks } from './checks/workers-compat';
import { wranglerChecks } from './checks/wrangler';
import type { Check } from './types';

/** Tags every check of a group with the platforms it applies to (keeps explicit tags). */
function onlyOn(platforms: DeployPlatform[], checks: Check[]): Check[] {
  return checks.map((c) => (c.platforms ? c : { ...c, platforms }));
}

/** Every doctor check, in report order. */
export const allChecks: Check[] = [
  ...environmentChecks,
  ...nextjsChecks,
  ...onlyOn(['cloudflare'], opennextChecks),
  ...onlyOn(['cloudflare'], openNextCacheChecks),
  ...onlyOn(['cloudflare'], wranglerChecks),
  ...onlyOn(['vercel'], vercelChecks),
  ...onlyOn(['cloudflare'], workersCompatChecks),
  ...hypdrivChecks,
  ...sizeChecks,
  ...securityChecks,
  ...purserChecks,
  ...depsChecks,
];

export function findCheck(id: string): Check | undefined {
  return allChecks.find((c) => c.id === id);
}
