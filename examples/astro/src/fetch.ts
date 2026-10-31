// Astro 7 advanced routing entry. Wrapping it extends the Hypdriv pipeline to what Astro answers before middleware:
// unmatched URLs served by the prerendered 404 page, `redirects` from the Astro config and trailing-slash
// normalisation. The middleware passes through inside it (and both pass through inside the Cloudflare Worker shell).
import { withHypDriv } from '@hypdriv/astro/fetch';
import { astro } from 'astro/fetch';

export default withHypDriv((state) => astro(state));
