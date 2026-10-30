import { depsChecks } from './checks/deps';
import { environmentChecks } from './checks/environment';
import { hypdrivChecks } from './checks/hypdriv';
import { nextjsChecks } from './checks/nextjs';
import { opennextChecks } from './checks/opennext';
import { purserChecks } from './checks/purser';
import { securityChecks } from './checks/security';
import { sizeChecks } from './checks/size';
import { workersCompatChecks } from './checks/workers-compat';
import { wranglerChecks } from './checks/wrangler';
import type { Check } from './types';

/** Every doctor check, in report order. */
export const allChecks: Check[] = [
  ...environmentChecks,
  ...nextjsChecks,
  ...opennextChecks,
  ...wranglerChecks,
  ...workersCompatChecks,
  ...hypdrivChecks,
  ...sizeChecks,
  ...securityChecks,
  ...purserChecks,
  ...depsChecks,
];

export function findCheck(id: string): Check | undefined {
  return allChecks.find((c) => c.id === id);
}
