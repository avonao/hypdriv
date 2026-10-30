import type { EdgePurger } from '@hypdriv/cache';
import { type Logger, readEnv, type ResolvedConfig, toError } from '@hypdriv/core';
import { vercelRequestContext } from './context';
import { MAX_TAGS_PER_PURGE, pathTag, sanitizeTags } from './tags';
import { chunk, defaultLogger, readFirstEnv, retryAfterMs, sleep, warnOnce } from './util';

/** `invalidate` marks entries stale (served while revalidating); `delete` drops them (foreground revalidation). */
export type PurgeMode = 'invalidate' | 'delete';

/** Options of the tag purge helpers. */
export interface VercelPurgeOptions {
  /** Environment for the REST fallback credentials (default: `process.env` through `readEnv`). */
  env?: Record<string, unknown>;
  /** Supplies `vercel.purge.tokenEnv` / `teamIdEnv` / `projectIdEnv` (defaults `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`). */
  config?: ResolvedConfig;
  fetch?: typeof fetch;
  log?: Logger;
  /**
   * Environment purged through the REST API: `production`, `preview`, or `null` for every environment.
   * Default: the current `VERCEL_ENV` when it is `production` or `preview`, otherwise every environment.
   * (The request-context API always purges the environment of the running deployment.)
   */
  target?: 'production' | 'preview' | null;
  /** REST API origin (default `https://api.vercel.com`). */
  apiBase?: string;
  /** Longest `Retry-After` honoured before the single retry of a rate-limited call (default 10000 ms). */
  maxRetryAfterMs?: number;
  /** Use the Vercel request-context purge API when available (default true). */
  useRequestContext?: boolean;
}

/** Options of `deleteTags`. */
export interface VercelDeleteTagsOptions extends VercelPurgeOptions {
  /** Seconds during which stale content may still be served while revalidating (default 0). */
  revalidationDeadlineSeconds?: number;
}

const DEFAULT_PURGE_ENV = { tokenEnv: 'VERCEL_TOKEN', teamIdEnv: 'VERCEL_TEAM_ID', projectIdEnv: 'VERCEL_PROJECT_ID' };

interface RestTarget {
  url: string;
  token: string;
  target: 'production' | 'preview' | undefined;
}

function restTarget(mode: PurgeMode, options: VercelPurgeOptions): RestTarget | null {
  const env = options.env ?? {};
  const names = options.config?.vercel.purge ?? DEFAULT_PURGE_ENV;
  const token = readFirstEnv(env, [names.tokenEnv]);
  const project = readFirstEnv(env, [names.projectIdEnv, 'VERCEL_PROJECT_ID']);
  if (!token || !project) return null;
  const team = readFirstEnv(env, [names.teamIdEnv]);
  const query = new URLSearchParams({ projectIdOrName: project });
  if (team) query.set('teamId', team);
  const base = (options.apiBase ?? 'https://api.vercel.com').replace(/\/+$/, '');
  const path = mode === 'invalidate' ? 'invalidate-by-tags' : 'dangerously-delete-by-tags';
  let target: RestTarget['target'];
  if (options.target !== undefined) target = options.target ?? undefined;
  else {
    const current = readEnv(env, 'VERCEL_ENV');
    target = current === 'production' || current === 'preview' ? current : undefined;
  }
  return { url: `${base}/v1/edge-cache/${path}?${query}`, token, target };
}

async function restPurge(
  rest: RestTarget,
  tags: string[],
  body: Record<string, unknown>,
  options: VercelPurgeOptions,
  log: Logger,
): Promise<boolean> {
  const doFetch = options.fetch ?? fetch;
  const maxWait = options.maxRetryAfterMs ?? 10_000;
  const payload = JSON.stringify({ tags, ...(rest.target ? { target: rest.target } : {}), ...body });
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await doFetch(rest.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${rest.token}`, 'content-type': 'application/json' },
        body: payload,
      });
    } catch (error) {
      log.warn('vercel purge: request failed', { tags: tags.length, error: toError(error).message });
      return false;
    }
    if (res.ok) {
      void res.body?.cancel().catch(() => undefined);
      return true;
    }
    const text = await res.text().catch(() => '');
    if (res.status === 429 && attempt === 0) {
      const wait = retryAfterMs(res.headers.get('retry-after')) ?? 1000;
      if (wait <= maxWait) {
        await sleep(wait);
        continue;
      }
    }
    log.warn('vercel purge: API rejected the purge', {
      tags: tags.length,
      status: res.status,
      body: text.slice(0, 300),
    });
    return false;
  }
  return false;
}

/**
 * Purges Vercel CDN cache tags (sanitised like the CDN stage emits them, at most 16 per call). Inside a
 * Vercel Function or Routing Middleware the request-context purge API is used (what `@vercel/functions`
 * `invalidateByTag` / `dangerouslyDeleteByTag` call); otherwise, or when it fails, the REST API
 * (`POST /v1/edge-cache/{invalidate-by-tags,dangerously-delete-by-tags}`) with the configured token and
 * project, retrying once after `Retry-After` on HTTP 429. Errors are logged, never thrown. Resolves to the
 * number of tags purged.
 */
export async function purgeVercelTags(
  mode: PurgeMode,
  tags: Iterable<string>,
  options: VercelDeleteTagsOptions = {},
): Promise<number> {
  const log = options.log ?? defaultLogger();
  const unique = sanitizeTags(tags);
  if (!unique.length) return 0;
  const deadline =
    mode === 'delete' && options.revalidationDeadlineSeconds !== undefined
      ? Math.max(0, Math.min(31_536_000, Math.floor(options.revalidationDeadlineSeconds)))
      : undefined;
  let purged = 0;
  let rest: RestTarget | null | undefined;
  for (const batch of chunk(unique, MAX_TAGS_PER_PURGE)) {
    const api = options.useRequestContext === false ? undefined : vercelRequestContext()?.purge;
    if (api) {
      try {
        if (mode === 'invalidate') await api.invalidateByTag(batch);
        else await api.dangerouslyDeleteByTag(batch, deadline !== undefined ? { revalidationDeadlineSeconds: deadline } : {});
        purged += batch.length;
        continue;
      } catch (error) {
        log.warn('vercel purge: request-context purge failed; trying the REST API', {
          tags: batch.length,
          error: toError(error).message,
        });
      }
    }
    if (rest === undefined) rest = restTarget(mode, options);
    if (!rest) {
      warnOnce(
        log,
        'vercel-purge:no-credentials',
        'vercel purge: no Vercel request context and no REST credentials (vercel.purge.tokenEnv / projectIdEnv); CDN tags were not purged',
      );
      return purged;
    }
    const ok = await restPurge(
      rest,
      batch,
      deadline !== undefined ? { revalidationDeadlineSeconds: deadline } : {},
      options,
      log,
    );
    if (ok) purged += batch.length;
  }
  return purged;
}

/** Marks every CDN entry carrying one of the tags stale (served while it revalidates in the background). */
export function invalidateTags(tags: Iterable<string>, options: VercelPurgeOptions = {}): Promise<number> {
  return purgeVercelTags('invalidate', tags, options);
}

/**
 * Deletes every CDN entry carrying one of the tags (`dangerously-delete-by-tags`): the next request renders in
 * the foreground, so prefer `invalidateTags` unless content must disappear. With
 * `revalidationDeadlineSeconds`, stale content is still served until the deadline.
 */
export function deleteTags(tags: Iterable<string>, options: VercelDeleteTagsOptions = {}): Promise<number> {
  return purgeVercelTags('delete', tags, options);
}

/** The Vercel CDN purger (`EdgePurger` for `registerEdgePurger`, also usable as the platform `purger`). */
export interface VercelPurger extends EdgePurger {
  /** Invalidates the tags; resolves to the number of tags purged. */
  purgeTags(tags: string[]): Promise<number>;
  /** Invalidates the `hyp:path:<pathname>` tag of each URL; resolves to the number of tags purged. */
  purgeUrls(urls: string[]): Promise<number>;
}

/** Options of `vercelPurger`. */
export interface VercelPurgerOptions {
  env: Record<string, unknown>;
  config: ResolvedConfig;
  fetch?: typeof fetch;
  log?: Logger;
}

/**
 * Creates the purger HypDriv's `revalidateTag` / `purgeEdge` reach on Vercel. Tags are invalidated (not
 * deleted), so visitors keep getting the stale entry while Vercel revalidates it. URLs map to the
 * `hyp:path:<pathname>` tag the CDN stage puts on every cached response.
 */
export function vercelPurger(options: VercelPurgerOptions): VercelPurger {
  const shared: VercelPurgeOptions = {
    env: options.env,
    config: options.config,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.log ? { log: options.log } : {}),
  };
  return {
    purgeTags: (tags) => invalidateTags(tags, shared),
    purgeUrls(urls) {
      const tags: string[] = [];
      for (const raw of urls) {
        try {
          tags.push(pathTag(new URL(raw, 'https://hypdriv.invalid').pathname));
        } catch {
          (options.log ?? defaultLogger()).warn('vercel purge: skipped an invalid URL', { url: String(raw).slice(0, 200) });
        }
      }
      return invalidateTags(tags, shared);
    },
  };
}
