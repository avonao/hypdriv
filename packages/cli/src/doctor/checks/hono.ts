import { readFileSync } from 'node:fs';
import { rel } from '../../util/fs';
import { type Check, fail, pass, skip, warn } from '../types';

const REGISTRATION =
  "useHypDriv(app, { config }) from '@hypdriv/hono' (or `export default wrapHono(app, { config })`)";

/**
 * The source with comments removed and the inside of string and template literals blanked (same length, so indices
 * hold). Returns `null` when a literal or comment is left open, i.e. the source is not something to reason about.
 */
export function maskSource(source: string): string | null {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
    } else if (c === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      if (close === -1) return null;
      out += source.slice(i, close + 2).replace(/[^\n]/g, ' ');
      i = close + 2;
    } else if (c === "'" || c === '"' || c === '`') {
      out += c;
      i += 1;
      let closed = false;
      while (i < source.length) {
        const d = source[i] as string;
        if (d === '\\') {
          out += source[i + 1] === '\n' ? ' \n' : '__';
          i += 2;
          continue;
        }
        if (d === c) {
          closed = true;
          break;
        }
        if (d === '\n' && c !== '`') return null;
        out += d === '\n' ? '\n' : '_';
        i += 1;
      }
      if (!closed) return null;
      out += c;
      i += 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

const ROUTE_METHODS = 'get|post|put|delete|patch|options|head|all|on|route|mount';

/**
 * Where the Hypdriv middleware sits in the entry, or `null` when it does not use it (or the source cannot be read
 * reliably). A Hono middleware only wraps the routes registered after it, so a route of the same app before it
 * answers without the Drivetrain.
 */
export function honoRegistration(source: string): { wrapped: boolean; routesBefore: string | null } | null {
  const code = maskSource(source);
  if (code === null) return null;
  if (/\bwrapHono\s*\(/.test(code)) return { wrapped: true, routesBefore: null };
  const use =
    /\b(?:useHypDriv\s*(?:<[^>]*>)?\s*\(\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*\.use\s*\(\s*(?:['"`][^'"`]*['"`]\s*,\s*)?hypdriv\s*\()/.exec(
      code,
    );
  if (!use) return null;
  const app = (use[1] ?? use[2]) as string;
  // A route call on the app itself (`app.get('/x', …)`) or chained on a call (`new Hono().get('/x', …)`), with a
  // path literal first: `Promise.all(…)`, `c.get('user')` and friends are not routes of the app.
  const routes = new RegExp(
    `(?:\\b${app.replace(/\$/g, '\\$')}|\\))\\s*\\.(${ROUTE_METHODS})\\s*\\(\\s*(?:\\[[^\\]]*\\]\\s*,\\s*)?['"\`]`,
  );
  const route = routes.exec(code.slice(0, use.index));
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
