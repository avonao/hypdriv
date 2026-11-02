import { join, resolve } from 'node:path';
import type { Options as AnalogPlatformOptions } from '@analogjs/platform';
import { installedVersion } from '@hypdriv/core/node';
import { type HypdrivNitroOptions, hypdrivNitro, type NitroModuleLike } from '@hypdriv/nitro';
import { readViteManifest } from '@hypdriv/vite';
import { type AnalogPagesOptions, analogPageAssets, discoverAnalogPages } from './routes';
import { viteState } from './state';

/** Options of the Analog integration. */
export interface HypdrivAnalogOptions
  extends Omit<HypdrivNitroOptions, 'routes' | 'isPage' | 'pageAssets' | 'framework'>,
    Omit<AnalogPagesOptions, 'root'> {}

/** The public path prefix of the client build's hashed files (`/assets/`), from the Vite config. */
function assetPrefix(): string {
  const { base = '/', assetsDir = 'assets' } = viteState();
  const prefix = `${base.endsWith('/') ? base : `${base}/`}${assetsDir.replace(/^\/+|\/+$/g, '')}`;
  return `${prefix.replace(/\/{2,}/g, '/')}/`;
}

/**
 * The Hypdriv Nitro module for Analog. It is {@link hypdrivNitro} configured for Analog's conventions: the pages
 * come from the file router (`src/app/pages`), every Nitro handler (`src/server/routes`, page endpoints) is an
 * endpoint, and the client assets come from the Vite client build's manifest (`build.manifest`, which the
 * {@link hypdriv} Vite plugin turns on).
 *
 * ```ts
 * // vite.config.ts
 * analog({ ssr: true, nitro: { modules: [hypdrivAnalog()] } })
 * ```
 */
export function hypdrivAnalog(options: HypdrivAnalogOptions = {}): NitroModuleLike {
  const { sourceRoot, workspaceRoot, additionalPagesDirs, additionalContentDirs, contentRoutes, ...nitro } =
    options;
  return {
    name: '@hypdriv/analog',
    setup(instance) {
      const root = resolve(options.root ?? viteState().root ?? instance.options.rootDir);
      const analog = installedVersion(root, '@analogjs/platform');
      const vite = installedVersion(root, 'vite');
      const outDir = viteState().clientOutDir;
      return hypdrivNitro({
        ...nitro,
        root,
        assetPrefixes: nitro.assetPrefixes ?? [assetPrefix()],
        framework: {
          name: 'analog',
          host: 'analog',
          ...(analog ? { version: analog } : {}),
          bundler: 'vite',
          ...(vite ? { bundlerVersion: vite } : {}),
        },
        routes: () =>
          discoverAnalogPages({
            root,
            ...(workspaceRoot ? { workspaceRoot } : {}),
            ...(sourceRoot ? { sourceRoot } : {}),
            ...(additionalPagesDirs ? { additionalPagesDirs } : {}),
            ...(additionalContentDirs ? { additionalContentDirs } : {}),
            ...(contentRoutes !== undefined ? { contentRoutes } : {}),
          }),
        // Analog's pages are its Angular routes; a Nitro handler is an API route, a page endpoint or a resource.
        isPage: () => false,
        pageAssets: analogPageAssets,
        // Nitro copies the client build into its public directory; the manifest is read from there, else from the
        // client output directory.
        clientManifest:
          nitro.clientManifest ??
          (({ publicDir }) =>
            readViteManifest(publicDir) ??
            readViteManifest(outDir ?? join(root, 'dist', 'client')) ??
            readViteManifest(join(root, 'dist', 'client'))),
      }).setup(instance);
    },
  };
}

/** The options of `analog()` (`@analogjs/platform`); Analog reads `sourceRoot` without declaring it. */
export type AnalogOptionsLike = AnalogPlatformOptions & { sourceRoot?: string };

type NitroModules = NonNullable<NonNullable<AnalogPlatformOptions['nitro']>['modules']>;

/** Analog's options with the Hypdriv module in `nitro.modules`. */
export type WithHypDriv<T extends AnalogOptionsLike> = T & {
  nitro: NonNullable<T['nitro']> & { modules: NitroModules };
};

/**
 * Analog's options with the Hypdriv module added to `nitro.modules`. The integration reads the options Analog's file
 * router uses (`sourceRoot`, `workspaceRoot`, `additionalPagesDirs`, `additionalContentDirs`) from the same object, so
 * the route manifest follows the app's layout.
 *
 * ```ts
 * plugins: [analog(withHypDriv({ ssr: true, prerender: { routes: ['/'] } })), hypdriv()]
 * ```
 */
export function withHypDriv<T extends AnalogOptionsLike>(
  analog: T = {} as T,
  options: HypdrivAnalogOptions = {},
): WithHypDriv<T> {
  const inherited: HypdrivAnalogOptions = {
    ...(analog.sourceRoot ? { sourceRoot: analog.sourceRoot } : {}),
    ...(analog.workspaceRoot ? { workspaceRoot: analog.workspaceRoot } : {}),
    ...(analog.additionalPagesDirs ? { additionalPagesDirs: analog.additionalPagesDirs } : {}),
    ...(analog.additionalContentDirs ? { additionalContentDirs: analog.additionalContentDirs } : {}),
  };
  return {
    ...analog,
    nitro: {
      ...analog.nitro,
      modules: [
        hypdrivAnalog({ ...inherited, ...options }) as NitroModules[number],
        ...(analog.nitro?.modules ?? []),
      ],
    },
  } as WithHypDriv<T>;
}
