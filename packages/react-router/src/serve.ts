#!/usr/bin/env node
import type { AddressInfo } from 'node:net';
import { parseArgs } from 'node:util';
import { serve } from './node';

/**
 * `hypdriv-react-router-serve [build/server/index.js]` — serves a React Router build with Hypdriv on Node
 * (`--port`, `--host`, `--client <dir>`, `--trust-proxy`; `PORT` and `HOST` from the environment by default).
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      client: { type: 'string' },
      'trust-proxy': { type: 'boolean' },
      'no-compression': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    console.log(
      'Usage: hypdriv-react-router-serve [build/server/index.js] [--port 3000] [--host 0.0.0.0] [--client build/client] [--trust-proxy] [--no-compression]',
    );
    return;
  }
  const server = await serve({
    ...(positionals[0] ? { build: positionals[0] } : {}),
    ...(values.port ? { port: Number(values.port) } : {}),
    ...(values.host ? { host: values.host } : {}),
    ...(values.client ? { clientDir: values.client } : {}),
    ...(values['trust-proxy'] ? { trustProxy: true } : {}),
    ...(values['no-compression'] ? { compression: false } : {}),
  });
  const address = server.address() as AddressInfo;
  const shown = address.address === '0.0.0.0' || address.address === '::' ? 'localhost' : address.address;
  console.log(`[hypdriv-react-router-serve] http://${shown}:${address.port}`);
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
