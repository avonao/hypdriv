import { flag, hyp } from '@hypdriv/nitro/server';
import { defineHandler } from 'nitro';

// Rate limited by the `api` policy in hypdriv.config.ts (60 requests per minute per IP).
export default defineHandler(() => {
  const context = hyp();
  return {
    message: 'Hello from Nitro 3, behind Hypdriv',
    requestId: context?.requestId ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    newHero: flag('newHero', false),
  };
});
