import type { ServerBuild } from 'react-router';
import { testBuild } from './build';

// Stand-in for `virtual:react-router/server-build` in tests.
const build = testBuild({ middleware: false });

export const assets: ServerBuild['assets'] = build.assets;
export const assetsBuildDirectory: ServerBuild['assetsBuildDirectory'] = build.assetsBuildDirectory;
export const basename: ServerBuild['basename'] = build.basename;
export const entry: ServerBuild['entry'] = build.entry;
export const future: ServerBuild['future'] = build.future;
export const isSpaMode: ServerBuild['isSpaMode'] = build.isSpaMode;
export const prerender: ServerBuild['prerender'] = build.prerender;
export const publicPath: ServerBuild['publicPath'] = build.publicPath;
export const routeDiscovery: ServerBuild['routeDiscovery'] = build.routeDiscovery;
export const routes: ServerBuild['routes'] = build.routes;
export const ssr: ServerBuild['ssr'] = build.ssr;
