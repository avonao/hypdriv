import {
  base64UrlEncode,
  defineStage,
  type GeoProperties,
  HEADER,
  type HypContext,
  type ResolvedConfig,
  type Stage,
  stateKey,
} from '@hypdriv/core';

export interface GeoInfo {
  country: string | null;
  region: string | null;
  regionCode: string | null;
  city: string | null;
  continent: string | null;
  postalCode: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  colo: string | null;
  asn: number | null;
  asOrganization: string | null;
  isEU: boolean;
  /** Where the data came from. */
  source: 'cloudflare' | 'vercel' | 'headers' | 'none';
}

export const GEO_KEY = stateKey<GeoInfo>('next.geo');

const EU = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
]);

function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Builds geo information from Cloudflare's `cf` object, falling back to common edge headers. */
export function geoFrom(cf: GeoProperties | undefined, headers: Headers): GeoInfo {
  if (cf && (cf.country || cf.colo)) {
    const country = str(cf.country);
    return {
      country,
      region: str(cf.region),
      regionCode: str(cf.regionCode),
      city: str(cf.city),
      continent: str(cf.continent),
      postalCode: str(cf.postalCode),
      timezone: str(cf.timezone),
      latitude: num(cf.latitude),
      longitude: num(cf.longitude),
      colo: str(cf.colo),
      asn: num(cf.asn),
      asOrganization: str(cf.asOrganization),
      isEU: cf.isEUCountry === '1' || (country ? EU.has(country) : false),
      source: 'cloudflare',
    };
  }
  const country =
    headers.get('cf-ipcountry') ?? headers.get('x-vercel-ip-country') ?? headers.get('x-country-code');
  if (country && country !== 'XX' && country !== 'T1') {
    const decode = (v: string | null) => {
      if (!v) return null;
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    const vercel = headers.has('x-vercel-ip-country');
    // `x-vercel-id` is `<edge region>::<function region>::<id>`; the first hop is the closest PoP.
    const vercelPop = vercel ? (headers.get('x-vercel-id')?.split('::')[0] ?? null) : null;
    const subdivision = decode(headers.get('x-vercel-ip-country-region'));
    return {
      country,
      region: subdivision,
      regionCode: subdivision,
      city: decode(headers.get('cf-ipcity') ?? headers.get('x-vercel-ip-city')),
      continent: headers.get('cf-ipcontinent') ?? headers.get('x-vercel-ip-continent'),
      postalCode: decode(headers.get('x-vercel-ip-postal-code')),
      timezone: headers.get('x-vercel-ip-timezone'),
      latitude: num(headers.get('cf-iplatitude') ?? headers.get('x-vercel-ip-latitude')),
      longitude: num(headers.get('cf-iplongitude') ?? headers.get('x-vercel-ip-longitude')),
      colo: vercelPop,
      asn: null,
      asOrganization: null,
      isEU: EU.has(country),
      source: vercel ? 'vercel' : 'headers',
    };
  }
  return {
    country: null,
    region: null,
    regionCode: null,
    city: null,
    continent: null,
    postalCode: null,
    timezone: null,
    latitude: null,
    longitude: null,
    colo: null,
    asn: null,
    asOrganization: null,
    isEU: false,
    source: 'none',
  };
}

/** Encodes geo info for the `x-hypdriv-geo` request header. */
export function encodeGeoHeader(geo: GeoInfo): string {
  const compact: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(geo)) if (v !== null && v !== false && k !== 'source') compact[k] = v;
  return base64UrlEncode(JSON.stringify(compact));
}

export function decodeGeoHeader(value: string | null): Partial<GeoInfo> | null {
  if (!value) return null;
  try {
    const bin = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as Partial<GeoInfo>;
  } catch {
    return null;
  }
}

/** Reads geo from `cf`/headers and forwards it to the application. */
export function geoStage(_config: ResolvedConfig): Stage {
  return defineStage({
    name: 'geo',
    pre(ctx: HypContext) {
      const geo = geoFrom(ctx.cf, ctx.request.headers);
      ctx.state.set(GEO_KEY, geo);
      if (geo.source !== 'none') {
        ctx.requestHeaders.set(HEADER.geo, encodeGeoHeader(geo));
        if (geo.country) ctx.requestHeaders.set('x-hypdriv-country', geo.country);
      }
    },
  });
}
