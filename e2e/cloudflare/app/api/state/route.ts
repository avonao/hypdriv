import { requireInternal } from '@/lib/internal';
import { kv } from '@/lib/kv';

/** Signed: every `e2e:*` record (cron ticks, queue jobs, dead letters, email) for the suite to verify. */
export async function GET(request: Request) {
  const denied = await requireInternal(request);
  if (denied) return denied;
  const store = await kv();
  const prefix = new URL(request.url).searchParams.get('prefix') ?? 'e2e:';
  const { keys } = await store.list({ prefix, limit: 1000 });
  const entries = await Promise.all(
    keys.map(async (k) => [k.name, JSON.parse((await store.get(k.name)) ?? 'null')] as const),
  );
  return Response.json(Object.fromEntries(entries), { headers: { 'cache-control': 'no-store' } });
}
