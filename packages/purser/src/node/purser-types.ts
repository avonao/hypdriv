/**
 * Local mirror of `@avonao/purser/build`'s public types (`types/build.d.ts`). Purser is an optional
 * host dependency and is never installed in this repository, so the bridge carries its own copy and
 * validates the loaded module's shape at run time.
 */

export interface PurserBuildOptions {
  /** Host project root; `typescript` and `postcss` resolve from here. */
  projectDir: string;
  /** Source directories or files, relative to projectDir. */
  src: string[];
  /** Module exporting the defineTokens() result, relative to projectDir. */
  tokens?: string;
  /** Output stylesheet, relative to projectDir. Omit to only validate. */
  out?: string;
  /** Class name prefix (default "x"); must match createCss({ prefix }). */
  prefix?: string;
  /** Hash salt (default ""); must match createCss({ salt }). */
  salt?: string;
  /** Import specifier of the runtime (default "@avonao/purser"). */
  packageName?: string;
  /** Module exporting a custom `css = createCss({ prefix, salt })`, relative to projectDir. */
  cssModule?: string;
  /** Names of the three cascade layers. */
  layers?: { tokens?: string; globals?: string; atoms?: string };
}

export interface PurserDiagnostic {
  severity: 'error' | 'warning';
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface PurserBuildStats {
  files: number;
  atoms: number;
  rules: number;
  keyframes: number;
  tokens: number;
}

export interface PurserBuildResult {
  /** The stylesheet, or null when there were errors. */
  css: string | null;
  diagnostics: PurserDiagnostic[];
  stats: PurserBuildStats | null;
  /** True when the output file changed on disk. */
  written: boolean;
  outFile: string | null;
}

export interface PurserWatchHandle {
  close(): void;
}

/** The shape of `@avonao/purser/build` the bridge relies on. */
export interface PurserBuildModule {
  build(options: PurserBuildOptions): Promise<PurserBuildResult>;
  check(options: Omit<PurserBuildOptions, 'out'>): Promise<PurserBuildResult>;
  watch(options: PurserBuildOptions, onResult: (result: PurserBuildResult) => void): Promise<PurserWatchHandle>;
  createBuilder?(options: PurserBuildOptions): {
    run(): Promise<PurserBuildResult>;
    projectDir: string;
    tokensFile: string | null;
    outFile: string | null;
  };
}
