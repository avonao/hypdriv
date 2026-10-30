import { cspHash } from '@hypdriv/core';
import { THEME_ATTRIBUTE, type ThemeAxis, type ThemeConfig, themeAxes } from './axes';

/** JSON that is safe to inline inside `<script>`: no `</script>` or line separators can appear. */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** `[name, cookieKey, classes, default, hint | 0, hintValues | 0]` per axis, in canonical order. */
function axisTable(axes: readonly ThemeAxis[]): unknown[] {
  return axes.map((axis) => {
    const classes: Record<string, string | null> = {};
    for (const key of Object.keys(axis.classes).sort()) classes[key] = axis.classes[key] ?? null;
    return [
      axis.name,
      axis.cookie,
      classes,
      axis.default,
      axis.clientHint ? axis.clientHint.hint : 0,
      axis.clientHint ? axis.clientHint.values : 0,
    ];
  });
}

/**
 * The inline fallback script, minified by hand. Before first paint it reads the theme cookie
 * (`axis=value;…`), falls back to `matchMedia('(<hint>: <value>)')` for axes with a client hint,
 * then to the axis default, and adds/removes the axis classes on `document.documentElement`. It also
 * sets `data-hypdriv-theme="axis=value;…"`, the same value the edge pin writes. Every API access is
 * guarded, so the script never throws (a sandboxed document without cookies simply gets defaults).
 *
 * The output is byte-identical for equal configuration (axes, values and hint maps are sorted), has
 * no nonce or request data inside, and can therefore be hashed once for CSP (`themeScriptHash`).
 */
export function buildThemeScript(theme: ThemeConfig): string {
  const axes = themeAxes(theme);
  const name = inlineJson(theme.cookie);
  const table = inlineJson(axisTable(axes));
  const attr = inlineJson(THEME_ATTRIBUTE);
  return (
    '!function(){try{var d=document.documentElement,h=Object.prototype.hasOwnProperty,' +
    `n=${name},A=${table},c={},o={},r=[],s,i,j,k,m,a,v;` +
    'try{s=document.cookie.split(";");for(i=0;i<s.length;i++){m=s[i].indexOf("=");' +
    'if(m>0&&s[i].slice(0,m).trim()==n){s=decodeURIComponent(s[i].slice(m+1)).split(";");' +
    'for(j=0;j<s.length;j++){k=s[j].indexOf("=");if(k>0)c[s[j].slice(0,k).trim()]=s[j].slice(k+1).trim();' +
    'else if(k<0&&A.length==1&&s[j].trim())c[A[0][1]]=s[j].trim()}break}}}catch(e){}' +
    'for(i=0;i<A.length;i++){a=A[i];v=c[a[1]];if(!h.call(a[2],v)){v=void 0;' +
    'if(a[4]&&typeof matchMedia=="function")for(k in a[5])try{' +
    'if(matchMedia("("+a[4]+": "+k+")").matches&&h.call(a[2],a[5][k])){v=a[5][k];break}}catch(e){}' +
    'if(v===void 0)v=a[3]}r.push(a[0]+"="+v);for(k in a[2])if(a[2][k])o[a[2][k]]=o[a[2][k]]||k===v}' +
    'for(k in o)d.classList[o[k]?"add":"remove"](k);' +
    `d.setAttribute(${attr},r.join(";"))}catch(e){}}();`
  );
}

/** CSP source for the fallback script: `'sha256-…'` of {@link buildThemeScript}'s exact output. */
export async function themeScriptHash(theme: ThemeConfig): Promise<string> {
  return cspHash(buildThemeScript(theme));
}

/**
 * `<script>` element for the root layout `<head>`. Pass the request nonce in nonce mode; in hash mode
 * the manifest's `purser.themeScriptHash` allows the script without a nonce.
 */
export function themeScriptTag(theme: ThemeConfig, nonce?: string | null): string {
  const attrs = nonce ? ` nonce="${nonce.replace(/[^A-Za-z0-9+/=_-]/g, '')}"` : '';
  return `<script data-hypdriv="theme"${attrs}>${buildThemeScript(theme)}</script>`;
}
