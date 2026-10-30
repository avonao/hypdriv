import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { PurserManifest, ResolvedPurser } from '@hypdriv/core';
import { sha256Hex } from '@hypdriv/core';
import { analyzeStylesheet } from '../analysis/stylesheet';
import { verifyAtomsAgainst } from '../analysis/verify';
import { buildThemeScript, themeScriptHash } from '../theme/script';

export type PrerenderedHtml = Record<string, string>;

export interface VerifyBuildOptions {
  /** The HypDriv project root. */
  projectDir: string;
  /** `resolveConfig(...).purser` (must not be `null`). */
  config: ResolvedPurser;
  /** Route id → prerendered HTML (and optionally RSC payload text), or a loader for it. */
  prerenderedHtml: PrerenderedHtml | (() => Promise<PrerenderedHtml>);
  /** Stylesheet to verify; defaults to `config.out` under the Purser project directory. */
  cssPath?: string;
}

export interface VerifyBuildResult {
  /** `false` only when `config.verify` is `'error'` and the guard found missing atoms (or no stylesheet). */
  ok: boolean;
  /** Manifest section for `.hypdriv/manifest.json`. */
  manifest: PurserManifest;
  /** Number of (route, class) pairs that reference an undeclared atom. */
  missingCount: number;
  /** Problems reported at `'error'` level. */
  errors: string[];
  /** Problems reported at `'warn'` level, plus notes. */
  warnings: string[];
  /** Absolute path of the stylesheet that was read (even when it did not exist). */
  stylesheetFile: string;
  /** `true` when `config.verify` is `'off'` (the manifest is still filled in). */
  skipped: boolean;
}

function describeMissing(missing: Record<string, string[]>, limit = 12): string[] {
  const lines: string[] = [];
  for (const [route, classes] of Object.entries(missing)) {
    const shown = classes.slice(0, limit).join(', ');
    const more = classes.length > limit ? ` (+${classes.length - limit} more)` : '';
    lines.push(`${route}: ${classes.length} unstyled atom${classes.length === 1 ? '' : 's'}: ${shown}${more}`);
  }
  return lines;
}

/**
 * The post-build guard: reads the generated stylesheet, checks that every Purser class referenced by
 * the prerendered documents exists in it, and produces the `purser` manifest section (atoms per
 * route, unused atoms, missing atoms, stylesheet hash, theme script + CSP hash). Honours
 * `config.verify`: `'error'` fails (`ok: false`) on missing atoms, `'warn'` reports them, `'off'`
 * skips the check but still fills the manifest.
 */
export async function verifyBuild(options: VerifyBuildOptions): Promise<VerifyBuildResult> {
  const { config } = options;
  const projectDir = resolve(options.projectDir);
  const purserProjectDir = resolve(projectDir, config.project);
  const stylesheetFile = options.cssPath ? resolve(projectDir, options.cssPath) : resolve(purserProjectDir, config.out);
  const errors: string[] = [];
  const warnings: string[] = [];
  const skipped = config.verify === 'off';
  const html =
    typeof options.prerenderedHtml === 'function' ? await options.prerenderedHtml() : options.prerenderedHtml;

  const manifest: PurserManifest = {
    stylesheet: relative(projectDir, stylesheetFile).split('\\').join('/') || stylesheetFile,
    stylesheetHash: '',
    atoms: 0,
    prefix: config.prefix,
    layers: { ...config.layers },
    atomsByRoute: {},
    unusedAtoms: [],
    missingAtoms: {},
  };

  if (config.theme?.fallbackScript) {
    manifest.themeScript = buildThemeScript(config.theme);
    manifest.themeScriptHash = await themeScriptHash(config.theme);
  }

  if (!existsSync(stylesheetFile)) {
    const message = `Purser stylesheet not found at ${manifest.stylesheet}; run the Purser build before next build (withHypDriv does this in PHASE_PRODUCTION_BUILD).`;
    if (skipped) warnings.push(message);
    else if (config.verify === 'warn') warnings.push(message);
    else errors.push(message);
    return {
      ok: errors.length === 0,
      manifest,
      missingCount: 0,
      errors,
      warnings,
      stylesheetFile,
      skipped,
    };
  }

  const css = await readFile(stylesheetFile, 'utf8');
  const analysis = analyzeStylesheet(css, config.prefix);
  manifest.stylesheetHash = (await sha256Hex(css)).slice(0, 16);
  manifest.atoms = analysis.atoms.size;
  if (analysis.layerStatement && analysis.layerStatement.length === 3) {
    const [tokens, globals, atoms] = analysis.layerStatement as [string, string, string];
    if (tokens !== config.layers.tokens || globals !== config.layers.globals || atoms !== config.layers.atoms) {
      warnings.push(
        `The stylesheet declares layers ${analysis.layerStatement.join(', ')} but hypdriv.config.ts expects ${config.layers.tokens}, ${config.layers.globals}, ${config.layers.atoms}; the bridge passes config.purser.layers to the build, so the file is stale.`,
      );
    }
  }

  const result = verifyAtomsAgainst(analysis.atoms, html, config.prefix);
  manifest.missingAtoms = result.missing;
  if (config.usageReport) {
    manifest.atomsByRoute = result.used;
    manifest.unusedAtoms = result.unused;
  }
  const missingCount = Object.values(result.missing).reduce((n, list) => n + list.length, 0);
  if (missingCount && !skipped) {
    const lines = [
      `${missingCount} Purser class${missingCount === 1 ? '' : 'es'} referenced by prerendered HTML ${missingCount === 1 ? 'is' : 'are'} missing from ${manifest.stylesheet} (stale stylesheet, or a class joined by hand outside css.props):`,
      ...describeMissing(result.missing),
    ];
    if (config.verify === 'error') errors.push(...lines);
    else warnings.push(...lines);
  }
  if (Object.keys(html).length === 0) {
    warnings.push('No prerendered HTML was provided; the unstyled-atom guard had nothing to check.');
  }

  return {
    ok: errors.length === 0,
    manifest,
    missingCount,
    errors,
    warnings,
    stylesheetFile,
    skipped,
  };
}
