/** The framework label `/_hypdriv/health` and the logs report. */
export const HOST_LABEL = 'solid-start';

/**
 * The module the Hypdriv Nitro module registers for the Nitro runtime plugin: the build's target, whether Nitro
 * runs its development server, and the public prefixes of content-hashed build assets.
 */
export const VIRTUAL_OPTIONS = 'virtual:hypdriv/solid-start';

/** Nitro's preset while it prerenders at build time: the Hypdriv pipeline stays out of the static documents. */
export const PRERENDER_PRESET = 'nitro-prerender';

/** SolidStart's build output directory for client assets (`build.assetsDir`), relative to the public base. */
export const DEFAULT_ASSETS_DIR = '_build/assets';

/** The path SolidStart serves server functions (`"use server"`) under. */
export const SERVER_FUNCTIONS_PATH = '/_server';
