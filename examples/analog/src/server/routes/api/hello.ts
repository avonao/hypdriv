import { flag, hyp } from '@hypdriv/analog/server';
import { defineEventHandler } from 'h3';

// Rate limited by the `api` policy in hypdriv.config.ts (60 requests per minute per IP).
export default defineEventHandler(() => {
  const context = hyp();
  return {
    message: 'Hello from Analog, behind Hypdriv',
    requestId: context?.requestId ?? null,
    runner: context?.runner ?? null,
    country: context?.country ?? null,
    newHero: flag('newHero', false),
  };
});
