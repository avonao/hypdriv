import { defineRoute } from 'hypdriv/server';
import { z } from 'zod';

/** Validation (Standard Schema), ETag/304 and route-level caching headers. */
export const GET = defineRoute({
  name: 'echo',
  query: z.object({ n: z.coerce.number().int().min(1).max(10) }),
  etag: true,
  cache: { maxAge: 30, swr: 60 },
  handler({ query }) {
    return { n: query.n, doubled: query.n * 2 };
  },
});

export const POST = defineRoute({
  name: 'echo-create',
  body: z.object({ title: z.string().min(1).max(80) }),
  maxBodyBytes: 1024,
  handler({ body }) {
    return Response.json({ created: body.title }, { status: 201 });
  },
});
