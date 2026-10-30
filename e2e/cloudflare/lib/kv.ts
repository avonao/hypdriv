import { hyp } from 'hypdriv/server';

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<{ keys: Array<{ name: string }> }>;
}

/** The suite's KV namespace (HYPDRIV_KV), shared with flags, redirects and maintenance. */
export async function kv(): Promise<KVLike> {
  const { env } = await hyp();
  const binding = env.HYPDRIV_KV as KVLike | undefined;
  if (!binding) throw new Error('HYPDRIV_KV is not bound');
  return binding;
}

/** Records a JSON value under `e2e:<key>` for an hour (the suite reads it back through /api/state). */
export async function record(key: string, value: unknown): Promise<void> {
  await (await kv()).put(`e2e:${key}`, JSON.stringify(value), { expirationTtl: 3600 });
}

export async function read<T>(key: string): Promise<T | null> {
  const raw = await (await kv()).get(`e2e:${key}`);
  return raw ? (JSON.parse(raw) as T) : null;
}
