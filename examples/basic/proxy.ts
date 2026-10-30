import { createProxy, matcher } from '@hypdriv/next/proxy';
import config from './hypdriv.config';

// Runs the same HypDriv stages on `next dev` / `next start`. On Cloudflare the Worker shell runs them.
export default createProxy(config);
export { matcher as config };
