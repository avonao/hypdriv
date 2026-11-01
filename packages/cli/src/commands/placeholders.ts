import { relative } from 'node:path';
import { UsageError } from '../args';
import { CliError, createContext } from '../context';
import { loadImageNode } from '../integrations';
import { defineCommand } from './types';

function choice<T extends string>(
  value: string | undefined,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new UsageError(`--${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export const placeholdersCommand = defineCommand({
  name: 'placeholders',
  summary:
    'Generate the blur placeholders for HypImage (sharp when installed, otherwise a built-in engine); --check verifies they are up to date',
  usage:
    'hypdriv placeholders [--check] [--engine auto|sharp|portable] [--format auto|webp|png] [--source <dir>] [--size 16]',
  options: {
    check: {
      type: 'boolean',
      description: 'Write nothing; exit 1 when the placeholders file is missing or out of date (CI)',
    },
    engine: {
      type: 'string',
      value: '<auto|sharp|portable>',
      description:
        'auto uses sharp when installed and the built-in PNG/JPEG/GIF engine otherwise (default: images.placeholders.engine)',
    },
    format: {
      type: 'string',
      value: '<auto|webp|png>',
      description:
        'Output format; auto is WebP when an encoder exists, PNG otherwise (default: images.placeholders.format)',
    },
    accuracy: {
      type: 'string',
      value: '<fast|exact>',
      description:
        'Built-in engine: fast reads big JPEGs from their DC coefficients, exact decodes them fully (default: images.placeholders.accuracy)',
    },
    source: {
      type: 'string',
      value: '<dir>',
      description: 'Directory served from the URL root (repeatable; default: images.placeholders.sources)',
      multiple: true,
    },
    size: {
      type: 'string',
      value: '<px>',
      description: 'Placeholder width, 4-64 (default: images.placeholders.size)',
    },
    quality: {
      type: 'string',
      value: '<1-100>',
      description: 'WebP quality (default: images.placeholders.quality)',
    },
    file: { type: 'string', value: '<path>', description: 'Output file (default: images.placeholders.file)' },
  },
  examples: [
    'hypdriv placeholders',
    'hypdriv placeholders --engine portable --format png',
    'hypdriv placeholders --check --json',
  ],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const config = await ctx.loadConfig();
    if (config.error) throw new CliError(`hypdriv.config failed to load: ${config.error}`);
    const settings = config.resolved.images.placeholders;
    if (!settings.enabled) {
      throw new CliError(
        'Image placeholders are disabled in hypdriv.config (images.placeholders.enabled: false).',
      );
    }

    const engine =
      choice(args.string('engine'), 'engine', ['auto', 'sharp', 'portable'] as const) ?? settings.engine;
    const format =
      choice(args.string('format'), 'format', ['auto', 'webp', 'png'] as const) ?? settings.format;
    const accuracy =
      choice(args.string('accuracy'), 'accuracy', ['fast', 'exact'] as const) ?? settings.accuracy;
    const size = args.number('size', settings.size, { min: 4, max: 64, integer: true });
    const quality = args.number('quality', settings.quality, { min: 1, max: 100, integer: true });
    const sources = args.list('source');
    const check = args.boolean('check');

    const image = await loadImageNode(ctx.root);
    if (!image?.generatePlaceholders) {
      throw new CliError(
        '@hypdriv/image is not installed (or is too old). Run `pnpm add @hypdriv/image`; placeholders work without sharp.',
      );
    }

    const warnings: string[] = [];
    const result = await image.generatePlaceholders({
      projectDir: ctx.root,
      sources: sources.length ? sources : settings.sources,
      size,
      quality,
      engine,
      format,
      accuracy,
      file: args.string('file') ?? settings.file,
      dryRun: check,
      log: { info() {}, warn: (message) => warnings.push(message) },
    });

    const file = relative(ctx.root, result.file) || result.file;
    const stale = result.generated + result.removed;
    const skippedHard = result.skipped !== undefined && result.skipped !== 'no-sources';
    const ok = !skippedHard && result.errors.length === 0 && !(check && stale > 0);

    if (args.json) {
      ui.printJson({
        command: 'placeholders',
        ok,
        mode: check ? 'check' : 'generate',
        engine: result.engine ?? null,
        format: result.format ?? null,
        generated: result.generated,
        reused: result.reused,
        removed: result.removed,
        total: result.total,
        file,
        skipped: result.skipped ?? null,
        message: result.message ?? null,
        errors: result.errors,
        unsupported: result.unsupported,
        warnings,
      });
      return ok ? 0 : 1;
    }

    ui.heading(check ? 'placeholders (check)' : 'placeholders');
    if (skippedHard) {
      ui.status('fail', result.message ?? `skipped: ${result.skipped}`);
      return 1;
    }
    if (result.skipped === 'no-sources') {
      ui.status(
        'skip',
        `no raster images found under ${(sources.length ? sources : settings.sources).join(', ')}`,
      );
      return 0;
    }
    const via = `${result.engine}, ${result.format}`;
    if (check) {
      ui.status(
        stale > 0 ? 'fail' : 'pass',
        stale > 0
          ? `${file} is out of date: ${result.generated} to generate, ${result.removed} to remove (${via})`
          : `${file} is up to date (${result.total} images, ${via})`,
      );
    } else {
      ui.status(
        result.errors.length ? 'warn' : 'pass',
        `${result.generated} generated, ${result.reused} reused, ${result.removed} removed → ${file} (${via})`,
      );
    }
    for (const failure of result.errors) ui.status('fail', failure.path, failure.error);
    for (const item of result.unsupported) ui.status('warn', item.path, item.reason);
    for (const message of warnings) {
      if (!result.unsupported.length || !message.includes('no placeholder')) ui.warn(message);
    }
    return ok ? 0 : 1;
  },
});
