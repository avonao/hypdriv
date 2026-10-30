/**
 * `@hypdriv/purser` — runtime-neutral half of the Purser CSS bridge: theme resolution and the `theme`
 * stage, the hashed fallback script, `@layer` composition and stylesheet/HTML atom analysis.
 * No Node.js APIs; usable in Workers, the Next.js proxy and server code. The build/verify/audit
 * tooling lives in `@hypdriv/purser/node`.
 */

export { extractHtmlClasses } from './analysis/html';
export {
  analyzeStylesheet,
  atomClassPattern,
  extractAtomClasses,
  extractLayerStatement,
  isPurserStylesheet,
  type StylesheetAnalysis,
  stripCssComments,
} from './analysis/stylesheet';
export {
  type VerifyAtomsInput,
  type VerifyAtomsResult,
  verifyAtoms,
  verifyAtomsAgainst,
} from './analysis/verify';
export { DEFAULT_PURSER_LAYERS, LAYER_NAME_RE, type LayerStatementOptions, layerStatement } from './layers';
export {
  allThemeClasses,
  CLIENT_HINT_HEADERS,
  CLIENT_HINT_TOKENS,
  type ClientHintName,
  CRITICAL_CLIENT_HINTS,
  decodeThemeHeader,
  encodeThemeCookieValue,
  encodeThemeValues,
  parseThemeCookie,
  THEME_ATTRIBUTE,
  type ThemeAxis,
  type ThemeAxisConfig,
  type ThemeConfig,
  themeAxes,
  themeClientHints,
} from './theme/axes';
export {
  type CompiledTheme,
  compileTheme,
  type ResolvedTheme,
  type ResolveThemeInput,
  resolveCompiledTheme,
  resolveTheme,
  THEME_KEY,
  type ThemeSource,
} from './theme/resolve';
export { buildThemeScript, themeScriptHash, themeScriptTag } from './theme/script';
export {
  applyThemeResponseHeaders,
  getHtmlRewriter,
  type HtmlRewriterConstructor,
  type HtmlRewriterElement,
  type HtmlRewriterLike,
  mergeThemeClasses,
  pinThemeResponse,
  THEME_RESOLVED_KEY,
  themeElementHandler,
  themeStage,
} from './theme/stage';
