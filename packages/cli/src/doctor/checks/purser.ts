import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { silentLogger } from '@hypdriv/core';
import { loadPurserNode } from '../../integrations';
import { exists, rel } from '../../util/fs';
import { type Check, fail, info, pass, skip, warn } from '../types';
import { purserActive } from './environment';

export const purserChecks: Check[] = [
  {
    id: 'purser.configured',
    title: 'Purser configuration',
    category: 'purser',
    severity: 'info',
    run(ctx) {
      const p = ctx.config.resolved.purser;
      if (!p) return skip('purser: false in hypdriv.config.');
      if (p.enabled === true) return pass(`enabled (out ${p.out}, prefix "${p.prefix}")`);
      if (p.enabled === false) return skip('purser.enabled is false.');
      if (purserActive(ctx))
        return pass(
          `auto-detected (@avonao/purser ${ctx.project.purser.installed}, tokens ${p.tokens ?? ctx.project.purser.tokensFile})`,
        );
      return info(
        'Purser bridge inactive (auto mode): install @avonao/purser and add a tokens module to enable the in-process build, verification and theming.',
      );
    },
  },
  {
    id: 'purser.installed',
    title: '@avonao/purser installed',
    category: 'purser',
    severity: 'error',
    run(ctx) {
      const p = ctx.config.resolved.purser;
      if (!p || p.enabled === false) return skip('Purser is not configured.');
      if (ctx.project.purser.installed) return pass(`@avonao/purser ${ctx.project.purser.installed}`);
      if (p.enabled === true)
        return fail(
          'purser.enabled is true but @avonao/purser is not installed (pnpm add -D @avonao/purser).',
        );
      return skip('@avonao/purser is not installed (auto mode stays off).');
    },
  },
  {
    id: 'purser.tokens',
    title: 'Purser tokens module',
    category: 'purser',
    severity: 'error',
    run(ctx) {
      const p = ctx.config.resolved.purser;
      if (!p || !purserActive(ctx)) return skip('Purser is not active.');
      if (p.tokens) {
        const file = join(ctx.root, p.project, p.tokens);
        if (!exists(file)) return fail(`purser.tokens points at ${p.tokens}, which does not exist.`);
        return pass(p.tokens);
      }
      if (ctx.project.purser.tokensFile)
        return pass(`${ctx.project.purser.tokensFile} (auto-detected; set purser.tokens to pin it)`);
      return warn('No tokens module found (lib/tokens.ts, app/tokens.ts, …); set purser.tokens.');
    },
  },
  {
    id: 'purser.stylesheet-import',
    title: 'Purser stylesheet imported in the root layout',
    category: 'purser',
    severity: 'warn',
    run(ctx) {
      const p = ctx.config.resolved.purser;
      if (!p || !purserActive(ctx)) return skip('Purser is not active.');
      const layout = ctx.project.layoutFile;
      if (!layout) return skip('no app/layout.tsx.');
      const source = readFileSync(layout, 'utf8');
      const name = basename(p.out);
      if (source.includes(name)) return pass(`${rel(ctx.root, layout)} imports ${name}.`);
      return warn(
        `${rel(ctx.root, layout)} does not import ${p.out}; add \`import './${name}'\` so the generated atoms ship.`,
      );
    },
  },
  {
    id: 'purser.check',
    title: 'purser check',
    category: 'purser',
    severity: 'error',
    async run(ctx) {
      const p = ctx.config.resolved.purser;
      if (!p || !purserActive(ctx)) return skip('Purser is not active.');
      if (!p.checkInDoctor) return skip('purser.checkInDoctor is false.');
      if (ctx.project.typescript.major !== null && ctx.project.typescript.major >= 7)
        return skip('TypeScript 7 host (see env.typescript-purser).');
      const mod = await loadPurserNode();
      if (!mod?.createPurserBridge)
        return skip('@hypdriv/purser/node createPurserBridge is unavailable in this installation.');
      try {
        const bridge = await mod.createPurserBridge({ projectDir: ctx.root, config: p, log: silentLogger });
        const result = await bridge.check();
        const errors = result.diagnostics.filter((d) => d.severity === 'error');
        const details = bridge.formatDiagnostics
          ? bridge.formatDiagnostics(result).split('\n').filter(Boolean)
          : result.diagnostics.map((d) => `${d.file ?? ''}:${d.line ?? ''} ${d.severity}: ${d.message}`);
        const stats = result.stats
          ? `${result.stats.atoms} atoms from ${result.stats.files} files`
          : 'checked';
        if (errors.length) return fail(`purser check reported ${errors.length} error(s).`, { details });
        if (result.diagnostics.length)
          return warn(`purser check passed with ${result.diagnostics.length} warning(s) (${stats}).`, {
            details,
          });
        return pass(`purser check passed (${stats}).`);
      } catch (err) {
        return fail(`purser check could not run: ${(err as Error).message}`);
      }
    },
  },
  {
    id: 'purser.verification',
    title: 'Unstyled-atom guard from the last build',
    category: 'purser',
    severity: 'error',
    run(ctx) {
      const m = ctx.manifest;
      if (!m?.purser) return skip('no Purser section in the manifest.');
      const missing = Object.entries(m.purser.missingAtoms).filter(([, atoms]) => atoms.length);
      if (missing.length)
        return fail(`${missing.length} route(s) reference atoms missing from the stylesheet.`, {
          details: missing.map(([route, atoms]) => `${route}: ${atoms.join(' ')}`),
        });
      return pass(
        `${m.purser.atoms} atoms · ${m.purser.unusedAtoms.length} unused · all referenced atoms present.`,
      );
    },
  },
];
