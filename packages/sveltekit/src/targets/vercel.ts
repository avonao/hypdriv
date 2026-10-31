import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mergeVercelRoutes,
  type StaticHeaderRule,
  VERCEL_ROUTE_MARKER,
  type VercelRoute,
} from '@hypdriv/build';
import { PRIVATE_BUILD_FILES } from '@hypdriv/vite';

interface VercelConfigJson {
  version: number;
  routes?: VercelRoute[];
  [key: string]: unknown;
}

const isHypDriv = (route: VercelRoute) => route.headers?.[VERCEL_ROUTE_MARKER] !== undefined;

/**
 * Places HypDriv's header routes in a Build Output route list: after the leading `continue: true` routes and
 * before the first route that ends the phase. adapter-vercel serves prerendered pages through rewrites without
 * `continue` (`{ src: '/about', dest: '/about/' }`), which come before `handle: filesystem`; header routes placed
 * after them would never apply to those pages.
 */
export function placeHeaderRoutes(routes: VercelRoute[]): VercelRoute[] {
  const own = routes.filter(isHypDriv);
  const rest = routes.filter((r) => !isHypDriv(r));
  let at = rest.findIndex((r) => r.handle !== undefined || r.continue !== true);
  if (at === -1) at = rest.length;
  return [...rest.slice(0, at), ...own, ...rest.slice(at)];
}

/**
 * Writes HypDriv's static header rules into adapter-vercel's `.vercel/output/config.json` (replacing the routes of a
 * previous run) and removes build metadata from the static output. Returns the number of header routes.
 */
export function writeVercelHeaders(
  outputDir: string,
  rules: StaticHeaderRule[],
): { file: string; routes: number } {
  const file = join(outputDir, 'config.json');
  if (!existsSync(file))
    throw new Error(`hypdriv: ${file} is missing; adapter-vercel did not write a Build Output`);
  const config = JSON.parse(readFileSync(file, 'utf8')) as VercelConfigJson;
  const routes = placeHeaderRoutes(mergeVercelRoutes(config.routes ?? [], rules));
  config.routes = routes;
  writeFileSync(file, `${JSON.stringify(config, null, '\t')}\n`);
  for (const name of PRIVATE_BUILD_FILES)
    rmSync(join(outputDir, 'static', name), { recursive: true, force: true });
  return { file, routes: routes.filter(isHypDriv).length };
}
