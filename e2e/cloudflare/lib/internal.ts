import { hyp, signing } from 'hypdriv/server';

/** Accepts only requests signed with HYPDRIV_INTERNAL_SECRET (the suite signs every control request). */
export async function requireInternal(request: Request): Promise<Response | null> {
  const { env } = await hyp();
  const secret = typeof env.HYPDRIV_INTERNAL_SECRET === 'string' ? env.HYPDRIV_INTERNAL_SECRET : '';
  if (!secret) return Response.json({ error: 'internal_secret_missing' }, { status: 503 });
  const copy = request.clone() as unknown as Parameters<typeof signing.verifyInternalRequest>[0];
  const ok = await signing.verifyInternalRequest(copy, secret, { ttlSeconds: 120 });
  return ok ? null : Response.json({ error: 'unauthorized' }, { status: 401 });
}
