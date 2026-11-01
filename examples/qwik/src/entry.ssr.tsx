import { createRenderer } from '@qwik.dev/router';
import Root from './root';

// Rendering is the same for every target (and for static generation); the Hypdriv pipeline wraps it in
// entry.<target>.tsx. Hypdriv injects each request's CSP nonce into the streamed HTML, so no nonce is passed here.
export default createRenderer((options) => ({
  jsx: <Root />,
  options: {
    ...options,
    containerAttributes: { lang: 'en-us', ...options.containerAttributes },
  },
}));
