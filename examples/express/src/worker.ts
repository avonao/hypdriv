// The Cloudflare Worker entry: Express runs on workerd through the `nodejs_compat` HTTP server (`cloudflare:node`).
// The Durable Objects are the ones Hypdriv's rate limiter, tag index and live channels use (bound in wrangler.jsonc).
import { httpServerHandler } from 'cloudflare:node';
import app from './app.js';

export { HypDrivChannel, HypDrivIndex, HypDrivLimiter } from '@hypdriv/cloudflare/durable-objects';

app.listen(8080);
export default httpServerHandler({ port: 8080 });
