import {
  type ExperimentMembership,
  experimentGeneration,
  type FlagDefinition,
  type Logger,
  parseCookies,
  parseExperimentCookie,
  serializeCookie,
  serializeExperimentCookie,
} from '@hypdriv/core';
import { EXPERIMENT_COOKIE_SECONDS, exposesOn, hasVariant } from './experiments';
import type { ExposureEvent, ExposureSink } from './exposure';

export interface ActivatedPrerender {
  /** The `Cookie` header of the beacon request. */
  cookieHeader: string | null;
  /** Where the prerendered page was opened (the beacon's `pathname`). */
  pathname: string;
  definitions: Record<string, FlagDefinition>;
  /** `flags.experimentCookie`. */
  cookieName: string;
  /** The route pattern the pathname matches (`/blog/[slug]`), when one does. */
  route?: { id: string; pathname: string } | null;
  country?: string;
  buildId?: string;
  /** The beacon request was made over https (decides the `Secure` attribute of the cookie). */
  secure: boolean;
  onExposure: ExposureSink;
  log?: Logger;
}

/**
 * Counts the exposures of a page the browser prerendered and the visitor then opened.
 *
 * A prerender is fetched with `Sec-Purpose: prefetch;prerender`, which the `flags` stage rightly does not count (the
 * visitor may never open it), and the activation sends no further request. The page's vitals beacon does: the web-vitals
 * library reports it with `navigationType: 'prerender'`. This turns that beacon into the exposure the fetch could not
 * be: for every experiment the visitor was assigned to (the cookie the prerender response set), whose `expose` paths
 * match the opened page, and that is still running under the same `salt`. Returns the `Set-Cookie` value that marks
 * them counted (`null` when nobody was, or the cookie cannot remember it), so a later real request does not count
 * them again. The audience was checked when the prerender was fetched, as the assignment itself was.
 */
export function exposeActivatedPrerender(input: ActivatedPrerender): string | null {
  const memberships = parseExperimentCookie(parseCookies(input.cookieHeader)[input.cookieName]);
  const names = Object.keys(memberships);
  if (!names.length) return null;
  let url: URL;
  try {
    url = new URL(input.pathname, 'https://hypdriv.internal');
  } catch {
    return null;
  }
  const next: Record<string, ExperimentMembership> = {};
  for (const name of names) next[name] = { ...memberships[name]! };
  const counted: string[] = [];
  for (const name of names) {
    const membership = next[name]!;
    const def = Object.hasOwn(input.definitions, name) ? input.definitions[name] : undefined;
    const spec = def?.experiment;
    if (!spec || (spec.status ?? 'running') === 'concluded' || membership.exposed) continue;
    if (!hasVariant(spec, membership.variant)) continue;
    if ((membership.generation ?? '') !== experimentGeneration(spec.salt)) continue;
    if (!exposesOn(spec, url)) continue;
    membership.exposed = true;
    counted.push(name);
  }
  if (!counted.length) return null;
  // Counted only if the cookie can remember it, as on a page view (an unstorable visitor would be counted every time).
  const stored = parseExperimentCookie(serializeExperimentCookie(next));
  const reported = counted.filter(
    (name) => stored[name]?.exposed && stored[name]?.variant === next[name]?.variant,
  );
  if (!reported.length) return null;
  for (const name of reported) {
    const event: ExposureEvent = {
      experiment: name,
      variant: next[name]!.variant,
      pathname: input.route?.pathname ?? '(unmatched)',
      ...(input.route ? { route: input.route.id } : {}),
      ...(input.country ? { country: input.country } : {}),
      ...(input.buildId ? { buildId: input.buildId } : {}),
      ts: Date.now(),
    };
    void Promise.resolve()
      .then(() => input.onExposure(event))
      .catch((error: unknown) =>
        input.log?.warn('experiment exposure failed', {
          experiment: name,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  // Experiments that were not counted keep the mark they had.
  for (const name of counted) if (!reported.includes(name)) next[name]!.exposed = false;
  return serializeCookie(input.cookieName, serializeExperimentCookie(next), {
    maxAge: EXPERIMENT_COOKIE_SECONDS,
    path: '/',
    sameSite: 'lax',
    httpOnly: true,
    secure: input.secure,
  });
}
