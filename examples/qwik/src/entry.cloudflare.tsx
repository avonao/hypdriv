import { createQwikRouter } from '@hypdriv/qwik/middleware/cloudflare';
import render from './entry.ssr';

// The Worker: Hypdriv's Worker shell (the Drivetrain, /_hypdriv/*, jobs) around Qwik Router. The Durable Object
// classes in wrangler.jsonc are exported from this module by the Hypdriv Vite plugin.
export default createQwikRouter({ render });
