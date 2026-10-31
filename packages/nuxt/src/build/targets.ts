/** The deployment platforms Hypdriv distinguishes. */
export type NuxtTarget = 'cloudflare' | 'vercel' | 'node';

/** The platform a Nitro preset deploys to (`cloudflare-module` → `cloudflare`, `vercel` → `vercel`, else `node`). */
export function targetOfPreset(preset: string | undefined): NuxtTarget {
  const name = (preset ?? '').replace(/_/g, '-').toLowerCase();
  if (name.startsWith('cloudflare')) return 'cloudflare';
  if (name.startsWith('vercel')) return 'vercel';
  return 'node';
}

/** Presets whose Worker entry Hypdriv replaces with its shell (`createWorker` around Nitro). */
export function supportsWorkerEntry(preset: string | undefined): boolean {
  const name = (preset ?? '').replace(/_/g, '-').toLowerCase();
  return name === 'cloudflare-module';
}

/** Presets that only emit static files (no server runtime). */
export function isStaticPreset(preset: string | undefined): boolean {
  const name = (preset ?? '').replace(/_/g, '-').toLowerCase();
  return name === 'static' || name.endsWith('-static') || name === 'github-pages';
}
