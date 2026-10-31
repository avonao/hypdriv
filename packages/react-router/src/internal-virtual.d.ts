// React Router's server build module as the HypDriv runtime imports it (the application's own typegen declares the
// same module for its code; this declaration only serves the package's type check).
declare module 'virtual:react-router/server-build' {
  import type { ServerBuild } from 'react-router';

  export const assets: ServerBuild['assets'];
  export const assetsBuildDirectory: ServerBuild['assetsBuildDirectory'];
  export const basename: ServerBuild['basename'];
  export const entry: ServerBuild['entry'];
  export const future: ServerBuild['future'];
  export const isSpaMode: ServerBuild['isSpaMode'];
  export const prerender: ServerBuild['prerender'];
  export const publicPath: ServerBuild['publicPath'];
  export const routeDiscovery: ServerBuild['routeDiscovery'];
  export const routes: ServerBuild['routes'];
  export const ssr: ServerBuild['ssr'];
}
