import { HypDrivError, type Logger, silentLogger } from '@hypdriv/core';
import { readStrikeScript } from '../detect';
import { type CdpClient, type CdpConnect, createCdpClient, webSocketConnect } from './cdp';
import { findChrome, type LaunchChromeOptions, type LaunchedChrome, launchChrome } from './chrome';

export type AuditState = 'default' | 'hover' | 'focus';

/** One overridden declaration as reported by Purser's `strike-count.js`. */
export interface StruckDeclaration {
  element: string;
  pseudo: string;
  property: string;
  sources: string[];
}

export interface AuditPage {
  url: string;
  width: number;
  state: AuditState;
  /** Root classes applied for this check (`[]` = as served). */
  theme: string[];
  /** Overridden declarations found. */
  count: number;
  struck: StruckDeclaration[];
  /** Author rules considered. */
  rules: number;
  /** Rules or states the script could not evaluate (`@container`, cross-origin sheets, no hover target…). */
  skipped: string[];
  /** Set when the page could not be loaded or evaluated; `count` is then `-1`. */
  error?: string;
}

export interface AuditReport {
  /** `true` when every check ran and found zero overridden declarations. */
  ok: boolean;
  pages: AuditPage[];
  chrome: { path: string; version: string };
  durationMs: number;
  /** Number of checks performed. */
  checks: number;
}

export interface AuditOverridesOptions {
  urls: string[];
  widths: number[];
  states: AuditState[];
  /** Chrome executable; otherwise `CHROME_PATH`, well-known locations and `PATH` are searched. */
  chromePath?: string;
  /** Source of Purser's `scripts/strike-count.js`; read from the project's installation when omitted. */
  strikeScript?: string;
  /** Project used to locate `@avonao/purser` when `strikeScript` is omitted (default `process.cwd()`). */
  projectDir?: string;
  /** Per-step timeout: Chrome start, navigation, evaluation (default 30 s). */
  timeoutMs?: number;
  /** Root class sets to test on `<html>`; `[]` keeps the served classes. Default `[[]]`. */
  themeClasses?: string[][];
  /** Viewport height (default 900). */
  height?: number;
  /**
   * Extra request headers for requests to the audited origins only (never third-party origins), e.g. the
   * signed `x-hypdriv-audit` token that lets the headless browser past HypDriv's bot shield.
   */
  headers?: Record<string, string>;
  log?: Logger;
  /** Chrome launcher override (tests). */
  launch?: (options: LaunchChromeOptions) => Promise<LaunchedChrome>;
  /** DevTools transport factory override (tests). Default: the runtime's global `WebSocket`. */
  connect?: CdpConnect;
}

const STATE_ORDER: AuditState[] = ['default', 'hover', 'focus'];

const INTERACTIVE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[role="button"],[tabindex]:not([tabindex="-1"])';

/**
 * Wraps Purser's strike-count script so one `Runtime.evaluate` installs it, runs it against the
 * current page state and returns the report as a JSON string (robust across protocol serialisation).
 */
export function wrapStrikeScript(source: string): string {
  return `(function(){${source}\n;return JSON.stringify(typeof purserStrikeCount==="function"?purserStrikeCount():null);})()`;
}

/** Page script: centre of the first visible interactive element (scrolled into view), or `{ found: false }`. */
export function hoverTargetScript(): string {
  return `(function(){var sel=${JSON.stringify(INTERACTIVE_SELECTOR)};var els=document.querySelectorAll(sel);var i,el,r;for(i=0;i<els.length;i++){el=els[i];r=el.getBoundingClientRect();if(r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth)return{found:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase()}}for(i=0;i<els.length;i++){el=els[i];r=el.getBoundingClientRect();if(r.width>0&&r.height>0){el.scrollIntoView({block:"center",inline:"center"});r=el.getBoundingClientRect();return{found:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase()}}}return{found:false}})()`;
}

/** Page script: focuses the first focusable element when nothing is focused yet; reports the outcome. */
export function focusScript(): string {
  return `(function(){var a=document.activeElement;if(!a||a===document.body||a===document.documentElement){var els=document.querySelectorAll(${JSON.stringify(INTERACTIVE_SELECTOR)});for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();if(r.width>0&&r.height>0){try{els[i].focus({focusVisible:true})}catch(e){els[i].focus()}break}}a=document.activeElement}var ok=!!a&&a!==document.body&&a!==document.documentElement;var fv=false;try{fv=ok&&a.matches(":focus-visible")}catch(e){}return{focused:ok,focusVisible:fv,tag:ok?a.tagName.toLowerCase():null}})()`;
}

/** Page script: HTTP status of the document's navigation (`0` when the browser does not expose it). */
export function navigationStatusScript(): string {
  return `(function(){try{var e=performance.getEntriesByType("navigation")[0];return e&&typeof e.responseStatus==="number"?e.responseStatus:0}catch(x){return 0}})()`;
}

/** Page script: replaces the theme classes on `<html>` (removes every known one, adds the chosen set). */
export function themeClassesScript(add: readonly string[], all: readonly string[]): string {
  return `(function(){var c=document.documentElement.classList,all=${JSON.stringify(all)},add=${JSON.stringify(add)},i;for(i=0;i<all.length;i++)c.remove(all[i]);for(i=0;i<add.length;i++)c.add(add[i]);return c.value})()`;
}

interface EvaluateResult {
  result: { type: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

async function evaluate<T>(client: CdpClient, sessionId: string, expression: string): Promise<T> {
  const r = await client.send<EvaluateResult>(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'unknown error';
    throw new HypDrivError('E_UPSTREAM', `page script failed: ${detail.slice(0, 400)}`);
  }
  return r.result?.value as T;
}

function orderedStates(states: readonly AuditState[]): AuditState[] {
  const wanted = new Set(states);
  const out = STATE_ORDER.filter((s) => wanted.has(s));
  return out.length ? out : ['default'];
}

/**
 * Zero-override audit: launches headless Chrome, loads every URL at every width (and root class set),
 * puts the page into the requested states (`default`, `hover` over the first interactive element,
 * keyboard `focus` on the first focusable element) and evaluates Purser's `strike-count.js`. Every
 * overridden declaration is a finding; `ok` is `true` only when all checks report zero.
 *
 * Degrades with `HypDrivError('E_UNSUPPORTED')` when no Chrome is found (set `CHROME_PATH`) or when
 * the runtime has no global `WebSocket` (Node 22+). Chrome is always killed and its temporary
 * profile removed, also on errors.
 */
export async function auditOverrides(options: AuditOverridesOptions): Promise<AuditReport> {
  const startedAt = Date.now();
  const log = options.log ?? silentLogger;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const height = options.height ?? 900;
  const found = findChrome({ chromePath: options.chromePath });
  if (!found) {
    throw new HypDrivError(
      'E_UNSUPPORTED',
      'No Chrome or Chromium executable was found. Install Google Chrome, or point CHROME_PATH (or --chrome) at a Chromium-based browser; the Purser audit drives it headless over the DevTools protocol.',
      { chromePath: options.chromePath ?? null, env: process.env.CHROME_PATH ?? null },
    );
  }
  const strikeSource = options.strikeScript ?? readStrikeScript(options.projectDir ?? process.cwd());
  const strikeExpression = wrapStrikeScript(strikeSource);
  const states = orderedStates(options.states);
  const themes = options.themeClasses?.length ? options.themeClasses.map((t) => [...t]) : [[]];
  const allThemeClassNames = [...new Set(themes.flat())];
  const widths = options.widths.length ? [...options.widths] : [1280];
  const pages: AuditPage[] = [];

  const chrome = await (options.launch ?? launchChrome)({ path: found.path, timeoutMs });
  let client: CdpClient | null = null;
  let version = 'unknown';
  try {
    client = createCdpClient(await (options.connect ?? webSocketConnect)(chrome.wsUrl), { timeoutMs });
    const info = await client.send<{ product?: string }>('Browser.getVersion');
    version = info.product ?? version;
    const { targetId } = await client.send<{ targetId: string }>('Target.createTarget', {
      url: 'about:blank',
    });
    const { sessionId } = await client.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    await client.send('Page.enable', {}, sessionId);
    await client.send('Runtime.enable', {}, sessionId);
    const extraHeaders = Object.entries(options.headers ?? {});
    if (extraHeaders.length) {
      // Fetch interception scoped to the audited origins keeps the headers away from third parties.
      const origins = [...new Set(options.urls.map((u) => new URL(u).origin))];
      const cdp = client;
      cdp.on('Fetch.requestPaused', (event) => {
        if (event.sessionId !== sessionId) return;
        const { requestId, request } = event.params as {
          requestId: string;
          request: { headers?: Record<string, string> };
        };
        const merged = new Map<string, string>();
        for (const [name, value] of Object.entries(request.headers ?? {}))
          merged.set(name.toLowerCase(), value);
        for (const [name, value] of extraHeaders) merged.set(name.toLowerCase(), value);
        cdp
          .send(
            'Fetch.continueRequest',
            { requestId, headers: [...merged].map(([name, value]) => ({ name, value })) },
            sessionId,
          )
          .catch(() => undefined);
      });
      await client.send(
        'Fetch.enable',
        { patterns: origins.map((origin) => ({ urlPattern: `${origin}/*`, requestStage: 'Request' })) },
        sessionId,
      );
    }

    const fail = (url: string, width: number, theme: string[], error: string) => {
      for (const state of states)
        pages.push({ url, width, state, theme, count: -1, struck: [], rules: 0, skipped: [], error });
    };

    for (const url of options.urls) {
      for (const width of widths) {
        await client.send(
          'Emulation.setDeviceMetricsOverride',
          { width, height, deviceScaleFactor: 1, mobile: width < 768 },
          sessionId,
        );
        for (const theme of themes) {
          try {
            const loaded = client.waitFor('Page.loadEventFired', { sessionId, timeoutMs });
            loaded.catch(() => undefined);
            const nav = await client.send<{ errorText?: string }>('Page.navigate', { url }, sessionId);
            if (nav.errorText) {
              fail(url, width, theme, `navigation failed: ${nav.errorText}`);
              continue;
            }
            await loaded;
            const status = await evaluate<number>(client, sessionId, navigationStatusScript());
            if (typeof status === 'number' && status >= 400) {
              fail(url, width, theme, `HTTP ${status}`);
              continue;
            }
            if (theme.length || allThemeClassNames.length) {
              await evaluate(client, sessionId, themeClassesScript(theme, allThemeClassNames));
            }
            for (const state of states) {
              const skipped: string[] = [];
              if (state === 'hover') {
                const target = await evaluate<{ found: boolean; x?: number; y?: number; tag?: string }>(
                  client,
                  sessionId,
                  hoverTargetScript(),
                );
                if (target.found && target.x !== undefined && target.y !== undefined) {
                  await client.send(
                    'Input.dispatchMouseEvent',
                    { type: 'mouseMoved', x: Math.round(target.x), y: Math.round(target.y) },
                    sessionId,
                  );
                } else skipped.push('no interactive element to hover');
              } else if (state === 'focus') {
                await client.send(
                  'Input.dispatchKeyEvent',
                  { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
                  sessionId,
                );
                await client.send(
                  'Input.dispatchKeyEvent',
                  { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
                  sessionId,
                );
                const focus = await evaluate<{ focused: boolean; focusVisible: boolean }>(
                  client,
                  sessionId,
                  focusScript(),
                );
                if (!focus.focused) skipped.push('no focusable element');
                else if (!focus.focusVisible) skipped.push('focused element does not match :focus-visible');
              }
              const json = await evaluate<string | null>(client, sessionId, strikeExpression);
              const report = json
                ? (JSON.parse(json) as {
                    count: number;
                    struck: StruckDeclaration[];
                    rules: number;
                    skipped: string[];
                  })
                : null;
              if (!report) {
                pages.push({
                  url,
                  width,
                  state,
                  theme,
                  count: -1,
                  struck: [],
                  rules: 0,
                  skipped,
                  error: 'strike-count script returned nothing',
                });
                continue;
              }
              // A page without evaluable author rules proves nothing: report it instead of a clean pass.
              const nothingEvaluated = report.rules === 0;
              pages.push({
                url,
                width,
                state,
                theme,
                count: nothingEvaluated ? -1 : report.count,
                struck: report.struck,
                rules: report.rules,
                skipped: [...skipped, ...report.skipped],
                ...(nothingEvaluated
                  ? {
                      error: `no author CSS rules could be evaluated${report.skipped.length ? ` (${report.skipped.slice(0, 3).join('; ')})` : ' (no stylesheet loaded)'}`,
                    }
                  : {}),
              });
              log.info('purser audit', { url, width, state, theme: theme.join(' '), count: report.count });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            fail(url, width, theme, message);
            if (client.closed) throw err;
          }
        }
      }
    }
    await client.send('Target.closeTarget', { targetId }).catch(() => undefined);
    await client.send('Browser.close').catch(() => undefined);
  } finally {
    client?.close();
    await chrome.close();
  }

  return {
    ok: pages.length > 0 && pages.every((p) => !p.error && p.count === 0),
    pages,
    chrome: { path: found.path, version },
    durationMs: Date.now() - startedAt,
    checks: pages.length,
  };
}

/** Formats a report for a terminal (`hypdriv audit css`). */
export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  for (const page of report.pages) {
    const theme = page.theme.length ? ` [${page.theme.join(' ')}]` : '';
    const head = `${page.url} @${page.width}px ${page.state}${theme}`;
    if (page.error) lines.push(`✖ ${head}: ${page.error}`);
    else if (page.count === 0) lines.push(`✔ ${head}: 0 overrides (${page.rules} rules)`);
    else {
      lines.push(`✖ ${head}: ${page.count} override${page.count === 1 ? '' : 's'}`);
      for (const s of page.struck.slice(0, 10))
        lines.push(`    ${s.element}${s.pseudo} ${s.property} ← ${s.sources.join(' | ')}`);
      if (page.struck.length > 10) lines.push(`    … ${page.struck.length - 10} more`);
    }
  }
  lines.push(
    `${report.ok ? 'ok' : 'failed'}: ${report.checks} check${report.checks === 1 ? '' : 's'} in ${report.durationMs}ms with ${report.chrome.version}`,
  );
  return lines.join('\n');
}
