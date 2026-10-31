import { resolve } from 'node:path';
import { UsageError } from '../args';
import { createContext } from '../context';
import { defineCommand } from './types';

/**
 * `hypdriv serve` — the production Node server for plain Vite apps: the build output behind the full HypDriv
 * pipeline (`@hypdriv/vite/node`).
 */
export const serveCommand = defineCommand({
  name: 'serve',
  summary: 'Serve a Vite build on Node behind the HypDriv pipeline (production server for plain Vite apps)',
  usage: 'hypdriv serve [--dir dist] [--port 3000] [--host 0.0.0.0] [--spa] [--trust-proxy]',
  options: {
    dir: {
      type: 'string',
      value: '<dir>',
      description: 'Build output directory (default dist)',
      default: 'dist',
    },
    port: { type: 'string', value: '<port>', description: 'Port (default $PORT or 3000)' },
    host: { type: 'string', value: '<host>', description: 'Interface (default $HOST or 0.0.0.0)' },
    spa: {
      type: 'boolean',
      description: 'Serve index.html for unknown navigations (default: when the build is a single-page app)',
    },
    'trust-proxy': {
      type: 'boolean',
      description: 'Trust x-forwarded-* from a reverse proxy (also HYPDRIV_TRUST_PROXY=1)',
    },
  },
  examples: ['hypdriv serve', 'PORT=8080 hypdriv serve --dir dist --trust-proxy'],
  async run(args, io) {
    const ctx = createContext(args, io);
    const { ui } = ctx;
    let mod: typeof import('@hypdriv/vite/node');
    try {
      mod = await import('@hypdriv/vite/node');
    } catch {
      throw new UsageError('hypdriv serve needs @hypdriv/vite (pnpm add @hypdriv/vite)');
    }
    const config = await ctx.loadConfig();
    if (config.error) throw new UsageError(`hypdriv.config is invalid: ${config.error}`);
    const port = args.number('port', Number(io.env.PORT ?? 3000), { min: 0, max: 65535 });
    const host = args.string('host') ?? io.env.HOST ?? '0.0.0.0';
    const dir = resolve(ctx.root, args.string('dir') ?? 'dist');
    const server = await mod.serve({
      root: ctx.root,
      dir,
      config: config.resolved,
      manifest: ctx.manifest(),
      port,
      host,
      ...(args.boolean('spa') ? { spa: true } : {}),
      trustProxy: args.boolean('trust-proxy') || io.env.HYPDRIV_TRUST_PROXY === '1',
    });
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;
    if (args.json) ui.printJson({ url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${bound}`, dir });
    else ui.status('pass', `Serving ${dir} on http://${host === '0.0.0.0' ? 'localhost' : host}:${bound}`);
    await new Promise<void>((done) => {
      const stop = () => server.close(() => done());
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return 0;
  },
});
