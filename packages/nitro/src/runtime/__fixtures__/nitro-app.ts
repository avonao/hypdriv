/** Stand-in for `nitro/app` (Nitro 3's runtime API) in the Nitro 3 plugin's tests. */
export const routeRules: Record<string, { cache?: unknown }> = {};

export function getRouteRules(
  _method: string,
  pathname: string,
): { routeRules?: { cache?: unknown } } {
  const rules = routeRules[pathname];
  return rules ? { routeRules: rules } : { routeRules: {} };
}
