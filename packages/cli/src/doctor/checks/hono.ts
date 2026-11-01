import { readFileSync } from 'node:fs';
import { rel } from '../../util/fs';
import { type Check, fail, pass, skip, warn } from '../types';

const REGISTRATION =
  "useHypDriv(app, { config }) from '@hypdriv/hono' (or `export default wrapHono(app, { config })`)";

/**
 * Where the Hypdriv middleware sits in the entry, or `null` when it does not use it. A Hono middleware only wraps
 * the routes registered after it, so a route before it answers without the Drivetrain.
 */
export function honoRegistration(source: string): { wrapped: boolean; routesBefore: string | null } | null {
  if (/\bwrapHono\s*\(/.test(source)) return { wrapped: true, routesBefore: null };
  const use = /\b(?:useHypDriv\s*\(|\.use\s*\(\s*(?:'[^']*'\s*,\s*)?hypdriv\s*\()/.exec(source);
  if (!use) return null;
  const route = /\.(get|post|put|delete|patch|options|head|all|on|route|mount)\s*\(/.exec(
    source.slice(0, use.index),
  );
  return { wrapped: false, routesBefore: route ? `.${route[1]}()` : null };
}

export const honoChecks: Check[] = [
  {
    id: 'hono.integration',
    title: 'Hypdriv integration package',
    category: 'hono',
    severity: 'error',
    frameworks: ['hono'],
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.integrationInstalled)
        return fail(
          `Hono ${f.version ?? ''} detected but @hypdriv/hono is not installed (pnpm add @hypdriv/hono).`,
        );
      return pass(`@hypdriv/hono@${f.integrationInstalled} for Hono ${f.version ?? ''}`.trim());
    },
  },
  {
    id: 'hono.registered',
    title: 'Drivetrain registered in the Hono entry',
    category: 'hono',
    severity: 'error',
    frameworks: ['hono'],
    run(ctx) {
      const f = ctx.project.framework;
      if (!f.configFile) return warn(`No Hono entry found (src/index.ts…); register ${REGISTRATION}.`);
      if (f.registered) return pass(`${rel(ctx.root, f.configFile)} references @hypdriv/hono.`);
      return fail(`${rel(ctx.root, f.configFile)} does not reference @hypdriv/hono; add ${REGISTRATION}.`);
    },
  },
  {
    id: 'hono.order',
    title: 'Middleware registered before the routes',
    category: 'hono',
    severity: 'error',
    frameworks: ['hono'],
    run(ctx) {
      const file = ctx.project.framework.configFile;
      if (!file || !ctx.project.framework.registered) return skip('the entry does not register Hypdriv.');
      let source: string;
      try {
        source = readFileSync(file, 'utf8');
      } catch {
        return skip(`${rel(ctx.root, file)} is not readable.`);
      }
      const found = honoRegistration(source);
      if (!found) return skip('registration not recognised (a custom setup); check the order by hand.');
      if (found.wrapped) return pass('wrapHono() wraps the whole app, whatever the order of its routes.');
      if (found.routesBefore)
        return fail(
          `${rel(ctx.root, file)} registers ${found.routesBefore} before the Hypdriv middleware: Hono middleware only wraps the routes registered after it. Move useHypDriv() to the top, or wrap the app with wrapHono().`,
        );
      return pass('the Hypdriv middleware is registered before the routes.');
    },
  },
];
