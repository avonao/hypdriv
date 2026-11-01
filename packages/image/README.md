# @hypdriv/image

Images for [Hypdriv](https://github.com/avonao/hypdriv) on Cloudflare: a `next/image` loader that emits `/cdn-cgi/image/...` URLs, build-time blur placeholders, and `createHypImage()` — a thin wrapper around `next/image` that applies the placeholders and sensible defaults.

OpenNext already serves `/_next/image` through the Images binding, so nothing here is required for images to work. The loader is an **optimisation for applications on a Cloudflare zone**: `/cdn-cgi/image` transformations are resized and cached by the zone without invoking the Worker.

## Install

```sh
pnpm add @hypdriv/image
```

Placeholder generation needs nothing else. Optional upgrades: `pnpm add -D sharp` (native, every format, WebP output) or `pnpm add -D @jsquash/webp @jsquash/avif` (WebAssembly: reads WebP and AVIF sources and encodes WebP placeholders without native modules).

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
pnpm exec hypdriv placeholders            # generate (incrementally) into .hypdriv/placeholders.json
pnpm exec hypdriv placeholders --check    # CI: exit 1 when the file is missing or out of date
```

`hypdriv placeholders` reads `images.placeholders` from `hypdriv.config.ts` (`sources`, `size`, `file`, `engine`, `format`, `quality`, `accuracy`; see the [configuration guide](../../docs/guides/configuration.md#images)). The same thing from code:

```ts
import { generatePlaceholders } from '@hypdriv/image/node';

const result = await generatePlaceholders({ sources: ['public'], size: 16 });
// { generated, reused, removed, total, file, engine, format, errors, unsupported }
```

`generatePlaceholders({ projectDir, sources, size, file, concurrency, quality, engine, format, accuracy, dryRun })` walks the source directories for `png/jpg/jpeg/webp/avif/gif`, resizes each to `size` px wide (never enlarging, aspect ratio kept) and writes `.hypdriv/placeholders.json`:

```json
{
  "version": 1,
  "generatedAt": "2026-10-30T12:00:00.000Z",
  "size": 16,
  "engine": "portable",
  "format": "png",
  "quality": 40,
  "placeholders": { "/hero.jpg": "data:image/png;base64,iVBORw0..." },
  "meta": { "/hero.jpg": { "mtimeMs": 1761825600000, "bytes": 184233, "width": 2400, "height": 1200 } }
}
```

Keys are `/`-prefixed public paths (`public/img/a.jpg` → `/img/a.jpg`). Runs are incremental: entries whose size and mtime match are reused (when engine, format, quality and size are unchanged), vanished sources are removed.

### Two engines

| | `sharp` | `portable` |
| --- | --- | --- |
| Needs | the native `sharp` package | nothing; optional `@jsquash/webp` and `@jsquash/avif` |
| Reads | everything sharp reads | PNG (all color types and depths, Adam7, `tRNS`), JPEG (baseline, progressive, any subsampling, restart intervals, grayscale, YCbCr, RGB, CMYK/YCCK), GIF (first frame); WebP and AVIF with the `@jsquash` codec |
| Writes | WebP (PNG with `format: 'png'`) | WebP with `@jsquash/webp`, otherwise PNG |

`engine: 'auto'` (the default) uses sharp when it is installed and the portable engine otherwise, so a CI image without native modules still produces placeholders instead of skipping them. `engine: 'sharp'` insists on sharp and returns `{ generated: 0, skipped: 'sharp-missing', message }` without it; `engine: 'portable'` never loads native code. The function never throws for a missing optional engine, and `format: 'webp'` without an encoder returns `skipped: 'engine-missing'`.

The portable engine recognises images by their bytes, not their extension, streams PNG rows and area-averages them straight into the 16-pixel result (a 24-megapixel PNG needs about 250 MB and half a second), and refuses images above `maxPixels` (134 million) before allocating. For big JPEGs it decodes only the DC coefficients, which are the exact means of the 8×8 blocks, so a 24-megapixel photo takes about 0.1 s and 80 MB; this is what libjpeg's reduced-size decoding, and so sharp's shrink-on-load, does too. Near sharp colour edges of chroma-subsampled pictures that is an approximation; `accuracy: 'exact'` decodes every JPEG completely (about 2.5 s per 24 megapixels). Pictures smaller than eight times the placeholder are always decoded completely.

Images that no installed codec can read (WebP or AVIF without sharp or the `@jsquash` codec) are listed in `unsupported` with the package to install, are not counted as errors and do not stop the others; files that fail to decode are listed in `errors` and make `hypdriv placeholders` exit `1`. `dryRun: true` decodes and writes nothing: `generated` then counts the images that would be regenerated.

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
- `@hypdriv/image/node`: `generatePlaceholders`, `readPlaceholdersFile`, `loadSharp`, `loadWasmCodecs`, `sniffFormat`, types `GeneratePlaceholdersOptions`, `GeneratePlaceholdersResult`, `PlaceholdersFile`, `WasmCodecs`

## License

MIT
