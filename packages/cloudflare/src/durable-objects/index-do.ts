import { DurableObject } from 'cloudflare:workers';

export { INDEX_SHARDS } from '../constants';

/**
 * `HypDrivIndex` — a tag → cache-key index backed by SQLite, sharded by tag hash. Used for exact
 * tag purges of the edge cache (ADR 0004: an optional upgrade over the KV/memory index).
 */
export class HypDrivIndex extends DurableObject {
  private ready = false;

  private init(): void {
    if (this.ready) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS tag_keys (
        tag TEXT NOT NULL,
        key TEXT NOT NULL,
        expires INTEGER NOT NULL,
        PRIMARY KEY (tag, key)
      );
      CREATE INDEX IF NOT EXISTS tag_keys_key ON tag_keys (key);
      CREATE INDEX IF NOT EXISTS tag_keys_expires ON tag_keys (expires);
      CREATE TABLE IF NOT EXISTS tag_purges (
        tag TEXT PRIMARY KEY,
        purged_until INTEGER NOT NULL
      );
    `);
    this.ready = true;
  }

  /**
   * Associates a cache key with tags; `ttlSeconds` bounds how long the association is kept. With
   * `fetchedAt`, answers `{ stale: true }` (and indexes nothing) when one of the tags was purged at or after
   * that time: the entry was generated before the purge took effect.
   */
  async add(
    key: string,
    tags: string[],
    ttlSeconds: number,
    nowArg?: number | null,
    fetchedAt?: number | null,
  ): Promise<{ stale: boolean }> {
    this.init();
    const now = typeof nowArg === 'number' ? nowArg : Date.now();
    if (typeof fetchedAt === 'number' && tags.length) {
      const placeholders = tags.map(() => '?').join(',');
      const hit = this.ctx.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM tag_purges WHERE tag IN (${placeholders}) AND purged_until >= ?`,
          ...tags,
          fetchedAt,
        )
        .one().n;
      if (hit > 0) return { stale: true };
    }
    const expires = now + Math.max(60, ttlSeconds) * 1000;
    for (const tag of tags) {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO tag_keys (tag, key, expires) VALUES (?, ?, ?)',
        tag,
        key,
        expires,
      );
    }
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000);
    return { stale: false };
  }

  /** Purge tombstones: entries for the tags fetched up to `until` (epoch ms) are dropped when indexed. */
  async markPurged(tags: string[], until: number): Promise<void> {
    this.init();
    for (const tag of tags)
      this.ctx.storage.sql.exec(
        'INSERT INTO tag_purges (tag, purged_until) VALUES (?, ?) ON CONFLICT(tag) DO UPDATE SET purged_until = MAX(purged_until, excluded.purged_until)',
        tag,
        until,
      );
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
  }

  /** Cache keys associated with any of the tags (expired associations are ignored). */
  async keysFor(tags: string[], now: number = Date.now()): Promise<string[]> {
    this.init();
    if (!tags.length) return [];
    const placeholders = tags.map(() => '?').join(',');
    const rows = this.ctx.storage.sql
      .exec<{ key: string }>(
        `SELECT DISTINCT key FROM tag_keys WHERE tag IN (${placeholders}) AND expires > ?`,
        ...tags,
        now,
      )
      .toArray();
    return rows.map((r) => r.key);
  }

  /** Removes keys from every tag (after a purge). */
  async remove(keys: string[]): Promise<number> {
    this.init();
    if (!keys.length) return 0;
    let removed = 0;
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const placeholders = chunk.map(() => '?').join(',');
      removed += this.ctx.storage.sql.exec(
        `DELETE FROM tag_keys WHERE key IN (${placeholders})`,
        ...chunk,
      ).rowsWritten;
    }
    return removed;
  }

  /** Removes every association for the given tags (used after a tag purge). */
  async clearTags(tags: string[]): Promise<number> {
    this.init();
    if (!tags.length) return 0;
    const placeholders = tags.map(() => '?').join(',');
    return this.ctx.storage.sql.exec(`DELETE FROM tag_keys WHERE tag IN (${placeholders})`, ...tags)
      .rowsWritten;
  }

  async stats(): Promise<{ associations: number; tags: number }> {
    this.init();
    const a = this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tag_keys').one().n;
    const t = this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(DISTINCT tag) AS n FROM tag_keys')
      .one().n;
    return { associations: a, tags: t };
  }

  override async alarm(): Promise<void> {
    this.init();
    const now = Date.now();
    this.ctx.storage.sql.exec('DELETE FROM tag_keys WHERE expires <= ?', now);
    // Tombstones only matter for requests in flight around the purge.
    this.ctx.storage.sql.exec('DELETE FROM tag_purges WHERE purged_until <= ?', now - 3_600_000);
    const remaining =
      this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tag_keys').one().n +
      this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM tag_purges').one().n;
    if (remaining > 0) await this.ctx.storage.setAlarm(now + 10 * 60 * 1000);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let body: { op?: string; args?: unknown[] };
    try {
      body = (await request.json()) as { op?: string; args?: unknown[] };
    } catch {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    const ops: Record<string, (...args: never[]) => Promise<unknown>> = {
      add: this.add.bind(this) as never,
      keysFor: this.keysFor.bind(this) as never,
      remove: this.remove.bind(this) as never,
      clearTags: this.clearTags.bind(this) as never,
      markPurged: this.markPurged.bind(this) as never,
      stats: this.stats.bind(this) as never,
    };
    const fn = body.op ? ops[body.op] : undefined;
    if (!fn) return Response.json({ error: 'unknown_op' }, { status: 400 });
    return Response.json((await fn(...((body.args ?? []) as never[]))) ?? null);
  }
}
