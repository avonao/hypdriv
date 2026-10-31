import { hypdrivRequestMiddleware } from '@hypdriv/tanstack-start';
import { createStart } from '@tanstack/react-start';

// Hypdriv first (it wraps everything below it: SSR documents, server routes, server functions, 404s), then
// Start's CSRF protection for server functions, which a custom src/start.ts would otherwise switch off.
const requestMiddleware = hypdrivRequestMiddleware();

export const startInstance = createStart(() => ({ requestMiddleware }));
