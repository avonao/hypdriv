/**
 * `@hypdriv/image` — Cloudflare image loader for `next/image`, blur placeholders and the `HypImage`
 * component factory.
 *
 * - `@hypdriv/image/loader`: the `images.loaderFile` module (default export `cloudflareLoader`).
 * - `@hypdriv/image/react`: `createHypImage(NextImage)`, `withPlaceholders`, `getPlaceholder`.
 * - `@hypdriv/image/node`: `generatePlaceholders()` (build time; `sharp` when installed, otherwise a built-in PNG/JPEG/GIF engine).
 *
 * This root entry re-exports the loader utilities (no React, no Node).
 */

export {
  buildCdnCgiUrl,
  buildNextImageUrl,
  type CdnCgiOptions,
  cloudflareLoader,
  configureImageLoader,
  getImageLoaderConfig,
  type ImageFit,
  type ImageFormat,
  type ImageGravity,
  type ImageLoaderConfig,
  type ImageMetadata,
  isCdnCgiEnabled,
  isPassthroughSource,
  type NextImageLoaderParams,
  resetInlinedImageConfig,
} from './loader';
