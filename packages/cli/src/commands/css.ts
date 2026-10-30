import { createConsoleLogger, silentLogger } from '@hypdriv/core';
import { UsageError } from '../args';
import { CliError, createContext } from '../context';
import {
  loadPurserNode,
  missingExport,
  type PurserBridgeLike,
  type PurserBuildResultLike,
} from '../integrations';
import type { Ui } from '../ui';
import { defineCommand } from './types';

function summarize(bridge: PurserBridgeLike, result: PurserBuildResultLike): string {
  if (bridge.formatSummary) return bridge.formatSummary(result);
  const stats = result.stats ? `${result.stats.atoms} atoms from ${result.stats.files} files` : 'no stats';
  return `purser: ${result.written ? `wrote ${result.outFile ?? bridge.outFile}` : 'up to date'} (${stats})`;
}

function printResult(ui: Ui, bridge: PurserBridgeLike, result: PurserBuildResultLike): boolean {
  const errors = result.diagnostics.filter((d) => d.severity === 'error').length;
  const lines = bridge.formatDiagnostics
    ? bridge.formatDiagnostics(result).split('\n').filter(Boolean)
    : result.diagnostics.map(
        (d) => `${d.file ?? ''}${d.line ? `:${d.line}:${d.column ?? 1}` : ''} ${d.severity}: ${d.message}`,
      );
  for (const line of lines) ui.line(/\berror\b/.test(line) ? ui.color.red(line) : ui.color.yellow(line));
  ui.status(errors ? 'fail' : 'pass', errors ? `${errors} error(s)` : summarize(bridge, result));
  return errors === 0;
}

function resultJson(result: PurserBuildResultLike) {
  const { css: _css, ...rest } = result;
  return {
    ...rest,
    ok: !result.diagnostics.some((d) => d.severity === 'error'),
    cssBytes: result.css ? Buffer.byteLength(result.css) : 0,
  };
}

export const cssCommand = defineCommand({
  name: 'css',
  summary: 'Purser CSS build, check or watch through the HypDriv bridge (options from hypdriv.config)',
  usage: 'hypdriv css <build|check|watch>',
  options: {},
  subcommands: [
    { name: 'build', summary: 'Compile the stylesheet (writes purser.out when it changed)' },
    { name: 'check', summary: 'Validate without writing (CI)' },
    { name: 'watch', summary: 'Rebuild on change and write .hypdriv/dev/purser.json; stops on Ctrl+C' },
  ],
  examples: ['hypdriv css build', 'hypdriv css check --json', 'hypdriv css watch'],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    const sub = args.positionals[0];
    if (sub !== 'build' && sub !== 'check' && sub !== 'watch')
      throw new UsageError('css needs a subcommand: build, check or watch');
    const config = await ctx.loadConfig();
    if (config.error) throw new CliError(`hypdriv.config failed to load: ${config.error}`);
    const purser = config.resolved.purser;
    if (!purser) throw new CliError('Purser is disabled in hypdriv.config (purser: false).');
    const mod = await loadPurserNode();
    if (!mod?.createPurserBridge)
      throw new CliError(missingExport('@hypdriv/purser/node', 'createPurserBridge'));
    const log = args.json
      ? silentLogger
      : createConsoleLogger({
          format: 'pretty',
          level: 'warn',
          sink: (line) => io.stderr.write(`${line}\n`),
        });
    let bridge: PurserBridgeLike;
    try {
      bridge = await mod.createPurserBridge({ projectDir: ctx.root, config: purser, log });
    } catch (err) {
      throw new CliError((err as Error).message);
    }

    if (sub === 'build' || sub === 'check') {
      const result = sub === 'build' ? await bridge.build() : await bridge.check();
      if (args.json) {
        ui.printJson({ command: sub, ...resultJson(result) });
        return result.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
      }
      ui.heading(`purser ${sub}`);
      return printResult(ui, bridge, result) ? 0 : 1;
    }

    // watch
    ui.heading(`purser watch ${ui.color.dim('(Ctrl+C to stop)')}`);
    let last: PurserBuildResultLike | null = null;
    const handle = await bridge.watch(
      (result) => {
        last = result;
        if (args.json)
          io.stdout.write(
            `${JSON.stringify({ event: 'result', ts: io.date().toISOString(), ...resultJson(result) })}\n`,
          );
        else {
          ui.line(ui.color.dim(`[${io.date().toLocaleTimeString()}]`));
          printResult(ui, bridge, result);
        }
      },
      { devDiagnostics: true },
    );
    await io.interrupted();
    handle.close();
    if (!args.json) ui.note('\npurser watch stopped.');
    const final = last as PurserBuildResultLike | null;
    return final?.diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
  },
});
