import { defineRoute } from 'hypdriv/server';

export const GET = defineRoute({
  cache: { maxAge: 60, swr: 600 },
  async handler() {
    return { hello: 'world', at: new Date().toISOString() };
  },
});
