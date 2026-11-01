import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { loadImageNode } from '../../integrations';
import { type Check, type CheckContext, info, pass, skip, warn } from '../types';

/** `@hypdriv/image` is a dependency of the project, or its placeholders file is already there. */
function usesPlaceholders(ctx: CheckContext, file: string): boolean {
  const pkg = ctx.project.packageJson;
  if (pkg?.dependencies['@hypdriv/image'] || pkg?.devDependencies['@hypdriv/image']) return true;
  return ctx.project.hypdriv.packages['@hypdriv/image'] !== undefined || existsSync(file);
}

export const imageChecks: Check[] = [
  {
    id: 'images.placeholders',
    title: 'Blur placeholders',
    category: 'hypdriv',
    severity: 'warn',
    async run(ctx) {
      const settings = ctx.config.resolved.images.placeholders;
      if (!settings.enabled) return skip('images.placeholders.enabled is false.');
      const file = resolve(ctx.root, settings.file);
      if (!usesPlaceholders(ctx, file)) return skip('@hypdriv/image is not used in this project.');

      const image = await loadImageNode(ctx.root);
      if (!image?.generatePlaceholders) {
        return warn(
          '@hypdriv/image is declared but not installed (or too old to generate placeholders). Run your package manager install.',
        );
      }
      const options = {
        projectDir: ctx.root,
        sources: settings.sources,
        size: settings.size,
        quality: settings.quality,
        engine: settings.engine,
        format: settings.format,
        accuracy: settings.accuracy,
        file: settings.file,
        log: { info() {}, warn() {} },
      } as const;

      const plan = await image.generatePlaceholders({ ...options, dryRun: true });
      const where = relative(ctx.root, plan.file) || plan.file;
      if (plan.skipped === 'no-sources') {
        return skip(`no raster images found under ${settings.sources.join(', ')}.`);
      }
      if (plan.skipped) {
        return warn(plan.message ?? `placeholders were skipped (${plan.skipped}).`);
      }

      const via = `${plan.engine}, ${plan.format}`;
      const notes = plan.unsupported.map((u) => `${u.path}: ${u.reason}`);
      const stale = plan.generated + plan.removed;
      if (stale > 0) {
        return warn(
          `${where} is ${existsSync(file) ? 'out of date' : 'missing'}: ${plan.generated} to generate, ${plan.removed} to remove (${via}). Run \`hypdriv placeholders\` before building (a \`prebuild\` script keeps it current).`,
          {
            details: notes,
            fix: {
              description: `Run hypdriv placeholders (${via})`,
              async apply() {
                const result = await image.generatePlaceholders?.(options);
                if (result?.errors.length)
                  throw new Error(
                    `${result.errors.length} image(s) failed to decode: ${result.errors.map((e) => e.path).join(', ')}`,
                  );
              },
            },
          },
        );
      }
      const summary = `${where} is up to date (${plan.total} image${plan.total === 1 ? '' : 's'}, ${via}).`;
      if (notes.length) {
        return info(
          `${summary} ${plan.unsupported.length} image(s) have no placeholder because no installed codec reads them; install sharp, @jsquash/webp or @jsquash/avif.`,
          { details: notes },
        );
      }
      return pass(summary);
    },
  },
];
