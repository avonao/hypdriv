import { type ComponentType, createElement } from 'react';

/** `src` → `data:image/webp;base64,…` placeholder map (keys are `/`-prefixed public paths). */
export type Placeholders = Record<string, string>;

/** Shape of `.hypdriv/placeholders.json` written by `generatePlaceholders` (`@hypdriv/image/node`). */
export interface PlaceholdersFile {
  version: 1;
  generatedAt: string;
  size: number;
  placeholders: Placeholders;
  meta?: Record<string, { mtimeMs: number; bytes: number; width: number; height: number }>;
}

let registry: Placeholders = {};

function normalizeKey(src: string): string {
  const withoutQuery = src.split(/[?#]/)[0] ?? src;
  if (/^https?:\/\//i.test(withoutQuery)) return withoutQuery;
  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

/**
 * Registers placeholders for `HypImage` lookups. Accepts the flat map or the generated file object.
 * Call it once at module scope (both on the server and in the client bundle) with the JSON import:
 *
 * ```ts
 * import placeholders from '../.hypdriv/placeholders.json';
 * withPlaceholders(placeholders);
 * ```
 */
export function withPlaceholders(map: Placeholders | PlaceholdersFile | null | undefined): Placeholders {
  const flat = !map
    ? {}
    : 'placeholders' in map && typeof map.placeholders === 'object'
      ? map.placeholders
      : (map as Placeholders);
  const next: Placeholders = { ...registry };
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === 'string' && value.startsWith('data:')) next[normalizeKey(key)] = value;
  }
  registry = next;
  return registry;
}

/** Looks up the placeholder for a source (query strings are ignored). */
export function getPlaceholder(
  src: string | { src: string } | undefined | null,
  map: Placeholders = registry,
): string | undefined {
  if (!src) return undefined;
  const key = typeof src === 'string' ? src : src.src;
  return map[normalizeKey(key)];
}

/** Clears the registry (tests). */
export function resetPlaceholders(): void {
  registry = {};
}

/** The subset of `next/image` props `HypImage` reads or writes; everything else passes through. */
export interface BaseImageProps {
  src: string | { src: string; height?: number; width?: number; blurDataURL?: string };
  alt?: string;
  width?: number | `${number}`;
  height?: number | `${number}`;
  fill?: boolean;
  sizes?: string;
  priority?: boolean;
  placeholder?: 'blur' | 'empty' | `data:image/${string}`;
  blurDataURL?: string;
  decoding?: 'async' | 'auto' | 'sync';
  fetchPriority?: 'high' | 'low' | 'auto';
  loading?: 'lazy' | 'eager';
}

export interface HypImageExtras {
  /** Per-element placeholder map (overrides the registry). */
  placeholders?: Placeholders;
  /** Disable automatic placeholder/sizes/priority handling for this element. */
  plain?: boolean;
}

export interface CreateHypImageOptions {
  /** Placeholders registered for this component (merged over the global registry). */
  placeholders?: Placeholders | PlaceholdersFile;
  /** Default `sizes` for non-fill images given their width (default: `(max-width: Wpx) 100vw, Wpx`). */
  sizes?: (width: number) => string;
  /** `sizes` for `fill` images (default `100vw`). */
  fillSizes?: string;
}

/** Default `sizes` heuristic: an image never renders wider than the viewport or its intrinsic width. */
export function defaultSizes(width: number): string {
  return `(max-width: ${width}px) 100vw, ${width}px`;
}

/**
 * Wraps `next/image` without importing it (inject the component): adds `placeholder="blur"` +
 * `blurDataURL` from the placeholders map, a sensible `sizes` default (`100vw` for `fill`, viewport-
 * capped otherwise), `decoding="async"` and `fetchPriority="high"` for `priority` images.
 *
 * ```tsx
 * import Image from 'next/image';
 * import { createHypImage } from '@hypdriv/image/react';
 * export const HypImage = createHypImage(Image);
 * ```
 */
export function createHypImage<P extends BaseImageProps>(
  Image: ComponentType<P>,
  options: CreateHypImageOptions = {},
): ComponentType<P & HypImageExtras> {
  const local = options.placeholders ? withPlaceholdersLocal(options.placeholders) : null;
  const sizesFor = options.sizes ?? defaultSizes;
  const fillSizes = options.fillSizes ?? '100vw';

  function HypImage(props: P & HypImageExtras) {
    const { placeholders, plain, ...rest } = props;
    if (plain) return createElement(Image, rest as unknown as P);
    const next: BaseImageProps & Record<string, unknown> = { ...(rest as BaseImageProps) };

    if (!next.placeholder && !next.blurDataURL) {
      const dataUrl =
        (placeholders && getPlaceholder(next.src, placeholders)) ??
        (local && getPlaceholder(next.src, local)) ??
        getPlaceholder(next.src) ??
        (typeof next.src === 'object' ? next.src.blurDataURL : undefined);
      if (dataUrl) {
        next.placeholder = 'blur';
        next.blurDataURL = dataUrl;
      }
    }
    if (!next.sizes) {
      if (next.fill) next.sizes = fillSizes;
      else {
        const width = Number(next.width ?? (typeof next.src === 'object' ? next.src.width : undefined));
        if (Number.isFinite(width) && width > 0) next.sizes = sizesFor(width);
      }
    }
    if (!next.decoding) next.decoding = 'async';
    if (next.priority && !next.fetchPriority) next.fetchPriority = 'high';
    return createElement(Image, next as unknown as P);
  }
  HypImage.displayName = `HypImage(${Image.displayName ?? Image.name ?? 'Image'})`;
  return HypImage;
}

function withPlaceholdersLocal(map: Placeholders | PlaceholdersFile): Placeholders {
  const flat =
    'placeholders' in map && typeof map.placeholders === 'object' ? map.placeholders : (map as Placeholders);
  const out: Placeholders = {};
  for (const [key, value] of Object.entries(flat)) {
    if (typeof value === 'string' && value.startsWith('data:')) out[normalizeKey(key)] = value;
  }
  return out;
}
