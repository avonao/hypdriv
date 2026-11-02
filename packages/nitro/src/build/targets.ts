/** The deployment platforms Hypdriv distinguishes. */
export type NitroTarget = 'cloudflare' | 'vercel' | 'node';

function presetName(preset: string | undefined): string {
  return (preset ?? '').replace(/_/g, '-').toLowerCase();
}

/** The platform a Nitro preset deploys to (`cloudflare-module` → `cloudflare`, `vercel` → `vercel`, else `node`). */
export function targetOfPreset(preset: string | undefined): NitroTarget {
  const name = presetName(preset);
  if (name.startsWith('cloudflare')) return 'cloudflare';
  if (name.startsWith('vercel')) return 'vercel';
  return 'node';
}

/** Presets whose Worker entry Hypdriv replaces with its shell (`createWorker` around Nitro). */
export function supportsWorkerEntry(preset: string | undefined): boolean {
  return presetName(preset) === 'cloudflare-module';
}

/** Presets that only emit static files (no server runtime). */
export function isStaticPreset(preset: string | undefined): boolean {
  const name = presetName(preset);
  return name === 'static' || name.endsWith('-static') || name === 'github-pages';
}

/** The Nitro prerenderer's own instance (a second `createNitro` run with this preset renders the routes). */
export function isPrerenderPreset(preset: string | undefined): boolean {
  return presetName(preset) === 'nitro-prerender';
}

/** Development presets (`nitro-dev`, `cloudflare-dev`…). */
export function isDevPreset(preset: string | undefined): boolean {
  return presetName(preset).endsWith('-dev');
}
