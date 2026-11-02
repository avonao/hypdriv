/**
 * Hypdriv's Worker for Nuxt's `cloudflare-module` preset (the module's generated entry imports Nitro's polyfills
 * first, then re-exports this and the Durable Objects). Nuxt runs on Nitro 2, so it is the Worker of
 * `@hypdriv/nitro`: the Hypdriv shell (`createWorker`) around Nitro, with the prerendered documents answered from
 * the assets binding first. The virtual modules it imports (`virtual:hypdriv/config`, `virtual:hypdriv/manifest`)
 * are the ones this module provides.
 */
export { default } from '@hypdriv/nitro/runtime/nitro2/cloudflare-worker';
