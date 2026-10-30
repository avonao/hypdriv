# @hypdriv/image

Images for [HypDriv](https://github.com/avonao/hypdriv) on Cloudflare: a `next/image` loader that emits `/cdn-cgi/image/...` URLs, build-time blur placeholders, and `createHypImage()` — a thin wrapper around `next/image` that applies the placeholders and sensible defaults.

OpenNext already serves `/_next/image` through the Images binding, so nothing here is required for images to work. The loader is an **optimisation for applications on a Cloudflare zone**: `/cdn-cgi/image` transformations are resized and cached by the zone without invoking the Worker.

## Install

```sh
pnpm add @hypdriv/image
pnpm add -D sharp   # optional: enables placeholder generation
```

## Loader

`withHypDriv` sets `images.loaderFile` to `@hypdriv/image/loader` when `images.loader` is `'cloudflare'` (the default). To wire it by hand:

```ts
// next.config.ts
export default { images: { loader: 'custom', loaderFile: './node_modules/@hypdriv/image/dist/loader.js' } };
```

Behaviour of the default export `cloudflareLoader({ src, width, quality })`:

- production builds → `/cdn-cgi/image/width=<w>,quality=<q>,format=auto,fit=scale-down/<src>` (local paths are percent-encoded per segment; absolute URLs are kept verbatim after the slash);
- development (`NODE_ENV !== 'production'`) → `/_next/image?url=&w=&q=`, because `next dev` has no zone in front of it;
- `data:`, `blob:` and `.svg` sources pass through untouched.

Configure through `globalThis.__HYPDRIV_IMAGES__` (what `withHypDriv` writes) or `configureImageLoader()`:

```ts
import { configureImageLoader } from '@hypdriv/image';

configureImageLoader({
  cdnCgi: true, // true | false | 'auto' (default: production only)
  quality: 75,
  format: 'auto', // 'avif' | 'webp' | ...
  fit: 'scale-down',
  origin: 'https://images.example.com', // when a different zone serves /cdn-cgi/image
  basePath: '/app', // for /_next/image URLs
  options: { sharpen: 1, metadata: 'none' },
});
```

`globalThis.__HYPDRIV_IMAGE_CDN_CGI__ = false` is honoured as a kill switch. `buildCdnCgiUrl(options)` and `buildNextImageUrl(params)` are exported for custom loaders and tests.

## Placeholders

```sh
# build step (hypdriv css/build hooks call this; or run it yourself)
node -e "import('@hypdriv/image/node').then(m => m.generatePlaceholders({ sources: ['public'], size: 16 }))"
```

`generatePlaceholders({ projectDir, sources, size, file, concurrency, quality })` walks the source directories for `png/jpg/jpeg/webp/avif/gif`, resizes each to `size` px wide with `sharp`, encodes a `webp` at quality 40 and writes `.hypdriv/placeholders.json`:

```json
{
  "version": 1,
  "generatedAt": "2026-10-30T12:00:00.000Z",
  "size": 16,
  "placeholders": { "/hero.jpg": "data:image/webp;base64,UklGR..." },
  "meta": { "/hero.jpg": { "mtimeMs": 1761825600000, "bytes": 184233, "width": 2400, "height": 1200 } }
}
```

Keys are `/`-prefixed public paths (`public/img/a.jpg` → `/img/a.jpg`). Runs are incremental: entries whose size and mtime match are reused, vanished sources are removed. Without `sharp` the function returns `{ generated: 0, skipped: 'sharp-missing', message }` and never throws, so builds on machines without native modules still pass.

## `HypImage`

`@hypdriv/image/react` does not import `next/image`; you inject it once:

```tsx
// components/hyp-image.tsx
import Image from 'next/image';
import { createHypImage, withPlaceholders } from '@hypdriv/image/react';
import placeholders from '../.hypdriv/placeholders.json';

withPlaceholders(placeholders);
export const HypImage = createHypImage(Image);
```

```tsx
<HypImage src="/hero.jpg" width={2400} height={1200} alt="Hero" priority />
// renders next/image with placeholder="blur" + blurDataURL from the map,
// sizes="(max-width: 2400px) 100vw, 2400px", decoding="async", fetchPriority="high"
<HypImage src="/cover.jpg" fill alt="" /> // sizes="100vw"
```

Explicit props always win (`sizes`, `placeholder`, `decoding`, `fetchPriority`); `plain` disables the defaults for one element; `placeholders={{ ... }}` supplies a per-element map; `createHypImage(Image, { placeholders, sizes: (w) => ..., fillSizes })` customises the component. `getPlaceholder(src)` reads the registry directly (query strings are ignored).

## API

- `@hypdriv/image` / `@hypdriv/image/loader`: `cloudflareLoader` (default), `buildCdnCgiUrl`, `buildNextImageUrl`, `configureImageLoader`, `getImageLoaderConfig`, `isCdnCgiEnabled`, `isPassthroughSource`
- `@hypdriv/image/react`: `createHypImage`, `withPlaceholders`, `getPlaceholder`, `resetPlaceholders`, `defaultSizes`, types `Placeholders`, `PlaceholdersFile`, `BaseImageProps`
- `@hypdriv/image/node`: `generatePlaceholders`, `readPlaceholdersFile`, `loadSharp`

## License

MIT
