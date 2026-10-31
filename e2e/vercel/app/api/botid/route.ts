import { verifyBotId } from 'hypdriv/vercel';

/** BotID verdict for the caller: browsers that ran `initBotId()` send the challenge headers, scripts do not. */
export async function POST(request: Request) {
  const verdict = await verifyBotId();
  return Response.json(
    { verdict, challengeHeaders: [...request.headers.keys()].filter((h) => h.startsWith('x-is-human')) },
    { headers: { 'cache-control': 'no-store' } },
  );
}
