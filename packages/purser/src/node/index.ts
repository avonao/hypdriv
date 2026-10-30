/**
 * `@hypdriv/purser/node` — the Node.js half of the Purser CSS bridge: detection, in-process
 * build/check/watch through `@avonao/purser/build`, the post-build unstyled-atom guard, prerendered
 * HTML collection and the headless-Chrome zero-override audit.
 */

export {
  type AuditOverridesOptions,
  type AuditPage,
  type AuditReport,
  type AuditState,
  auditOverrides,
  focusScript,
  formatAuditReport,
  hoverTargetScript,
  type StruckDeclaration,
  themeClassesScript,
  wrapStrikeScript,
} from './audit';
export {
  type CdpClient,
  type CdpClientOptions,
  type CdpConnect,
  type CdpEvent,
  type CdpFrame,
  type CdpTransport,
  type CdpWaitOptions,
  createCdpClient,
  decodeFrame,
  encodeCommand,
  webSocketConnect,
} from './audit/cdp';
export {
  CHROME_PATH_NAMES,
  chromeArgs,
  type FindChromeOptions,
  type FoundChrome,
  findChrome,
  knownChromeLocations,
  type LaunchChromeOptions,
  type LaunchedChrome,
  launchChrome,
} from './audit/chrome';
export {
  closeAllPurserWatchers,
  createPurserBridge,
  formatPurserDiagnostic,
  loadPurserBuildModule,
  type PurserBridge,
  type PurserBridgeOptions,
  type PurserDevDiagnostics,
  purserBuildOptions,
  type StylesheetInfo,
  type WatchOptions,
} from './bridge';
export {
  detectPurser,
  findTokensFile,
  hostRequire,
  PURSER_INSTALL_HINT,
  type PurserDetection,
  readStrikeScript,
  resolvePackageJson,
  TOKENS_FILE_CANDIDATES,
  TYPESCRIPT6_ALIAS_HINT,
} from './detect';
export {
  type CollectPrerenderedOptions,
  collectPrerenderedHtml,
  pathnameFromPrerenderFile,
} from './prerendered';
export type {
  PurserBuildModule,
  PurserBuildOptions,
  PurserBuildResult,
  PurserBuildStats,
  PurserDiagnostic,
  PurserWatchHandle,
} from './purser-types';
export {
  type PrerenderedHtml,
  type VerifyBuildOptions,
  type VerifyBuildResult,
  verifyBuild,
} from './verify-build';
