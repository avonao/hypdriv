import { createConsoleLogger, type Logger } from '@hypdriv/core';
import type { Purger } from './types';

export interface ZonePurgerOptions {
  zoneId: string;
  token: string;
  fetch?: typeof fetch;
  log?: Logger;
  /** Cloudflare API base (default `https://api.cloudflare.com/client/v4`). */
  apiBase?: string;
}

/** Cloudflare's purge endpoint accepts at most 30 tags / files per call. */
export const PURGE_BATCH_SIZE = 30;

/**
 * Cloudflare zone purge (`POST /zones/:id/purge_cache`) by `Cache-Tag` or by URL, batched by 30.
 * Failures are logged, never thrown: purge is best effort and TTL/SWR bound staleness anyway.
 */
export function createZonePurger(options: ZonePurgerOptions): Purger {
  if (!options.zoneId || !options.token) throw new TypeError('createZonePurger needs zoneId and token');
  const log = options.log ?? createConsoleLogger({ level: 'warn' });
  const doFetch = options.fetch ?? fetch;
  const url = `${(options.apiBase ?? 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '')}/zones/${encodeURIComponent(options.zoneId)}/purge_cache`;

  const send = async (field: 'tags' | 'files', values: string[]) => {
    const unique = [...new Set(values.filter((v) => typeof v === 'string' && v.length > 0))];
    for (let i = 0; i < unique.length; i += PURGE_BATCH_SIZE) {
      const batch = unique.slice(i, i + PURGE_BATCH_SIZE);
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ [field]: batch }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          log.warn('edge-cache: zone purge failed', {
            field,
            count: batch.length,
            status: res.status,
            body: text.slice(0, 300),
          });
        } else {
          void res.body?.cancel().catch(() => undefined);
        }
      } catch (err) {
        log.warn('edge-cache: zone purge request failed', {
          field,
          count: batch.length,
          error: (err as Error)?.message,
        });
      }
    }
  };

  return {
    purgeTags: (tags) => send('tags', tags),
    purgeUrls: (urls) => send('files', urls),
  };
}
