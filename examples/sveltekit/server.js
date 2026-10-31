// Node: adapter-node's build behind the HypDriv pipeline (static files and prerendered pages included).
// `pnpm build:node && pnpm start`
import { serve } from '@hypdriv/sveltekit/node';

const server = await serve({ dir: 'build' });
const address = server.address();
console.log(
  `hypdriv: listening on ${typeof address === 'string' ? address : `http://localhost:${address?.port}`}`,
);
