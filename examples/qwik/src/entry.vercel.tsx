import { createQwikRouter } from '@hypdriv/qwik/middleware/vercel';
import render from './entry.ssr';

// The Node.js function of the Build Output API: every request the CDN cannot answer from a file.
export default createQwikRouter({ render });
