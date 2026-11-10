import type { ExpressLayerLike, ExpressRoutesSource } from './manifest';

/** Router layers that answer a request themselves: a route, a mounted router or app, a static file server. */
function answers(layer: ExpressLayerLike): boolean {
  return (
    Boolean(layer.route) ||
    layer.name === 'router' ||
    layer.name === 'mounted_app' ||
    layer.name === 'serveStatic'
  );
}

function describe(layer: ExpressLayerLike): string {
  if (layer.route) return `the route ${String((layer.route as { path?: unknown }).path)}`;
  if (layer.name === 'serveStatic') return 'a static file server';
  return layer.name === 'mounted_app' ? 'a mounted app' : 'a mounted router';
}

/**
 * What in the app's router stack defeats the Drivetrain, as sentences for the log. Routers run in registration
 * order, so a route, router or static server registered before `hypdriv()` answers without it; and a
 * `compression()` registered after it compresses the body before the pipeline reads it (a CSP nonce cannot be
 * injected into gzip), where registered before it, it compresses the pipeline's finished response.
 */
export function checkOrder(app: ExpressRoutesSource, middleware: unknown): string[] {
  const stack = app.stack ?? app.router?.stack ?? [];
  const index = stack.findIndex((layer) => layer.handle === middleware);
  if (index < 0) return [];
  const problems: string[] = [];
  const before = stack.slice(0, index).filter(answers);
  if (before.length)
    problems.push(
      `hypdriv() is registered after ${before.map(describe).join(', ')}: ${before.length === 1 ? 'it answers' : 'they answer'} without the Drivetrain (no security headers, rate limits or CSP). Register hypdriv() before routes, routers and static files.`,
    );
  if (stack.slice(index + 1).some((layer) => layer.name === 'compression'))
    problems.push(
      'compression() is registered after hypdriv(): it compresses the response before the Drivetrain reads it, so CSP nonces cannot be injected into the HTML. Register compression() before hypdriv().',
    );
  return problems;
}
