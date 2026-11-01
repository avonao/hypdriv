import { createQwikRouter } from '@hypdriv/qwik/middleware/node';
import render from './entry.ssr';

// `vite preview` after a Node build: the same pipeline as `pnpm start`.
export default createQwikRouter({ render });
