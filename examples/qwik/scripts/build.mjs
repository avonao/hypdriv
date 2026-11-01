// Builds the app for one target: the client build, then the server build with the target's adapter.
// The target is HYPDRIV_TARGET (cloudflare, vercel, node), else the platform's own build environment
// (VERCEL=1, CLOUDFLARE / WORKERS_CI), else node.
import { spawnSync } from 'node:child_process';
import { detectTarget } from '@hypdriv/qwik';

const target = detectTarget();
if (!target) {
  console.error('The Qwik example has no Hypdriv runtime for this platform; set HYPDRIV_TARGET.');
  process.exit(1);
}

const run = (args) => {
  const { status } = spawnSync('vite', args, {
    stdio: 'inherit',
    env: { ...process.env, HYPDRIV_TARGET: target },
  });
  if (status !== 0) process.exit(status ?? 1);
};

console.log(`Building for ${target}`);
run(['build']);
run(['build', '-c', `adapters/${target}/vite.config.ts`]);
