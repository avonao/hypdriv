import { createServer } from 'node:http';
import { createQwikRouter } from '@hypdriv/qwik/middleware/node';
import render from './entry.ssr';

// Static files (the prerendered pages and the hashed build) and Qwik Router, behind the Hypdriv Drivetrain.
const { listener } = createQwikRouter({ render });

const port = Number(process.env.PORT ?? 3000);
createServer(listener).listen(port, '0.0.0.0', () => {
  console.log(`Qwik listening on http://localhost:${port}`);
});
