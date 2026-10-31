import type { GeoProperties } from '@hypdriv/core';

/** Narrows Cloudflare's `request.cf` to the fields Hypdriv uses (and keeps the rest accessible). */
export function cloudflareGeo(cf: Record<string, unknown> | undefined): GeoProperties | undefined {
  if (!cf) return undefined;
  const s = (k: string) => (typeof cf[k] === 'string' ? (cf[k] as string) : undefined);
  const n = (k: string) => (typeof cf[k] === 'number' ? (cf[k] as number) : undefined);
  const bm = cf.botManagement as GeoProperties['botManagement'] | undefined;
  const out: GeoProperties = { ...cf };
  const assign = <K extends keyof GeoProperties>(key: K, value: GeoProperties[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  assign('country', s('country'));
  assign('region', s('region'));
  assign('regionCode', s('regionCode'));
  assign('city', s('city'));
  assign('continent', s('continent'));
  assign('postalCode', s('postalCode'));
  assign('timezone', s('timezone'));
  assign('latitude', s('latitude'));
  assign('longitude', s('longitude'));
  assign('colo', s('colo'));
  assign('asn', n('asn'));
  assign('asOrganization', s('asOrganization'));
  assign('isEUCountry', s('isEUCountry'));
  assign('httpProtocol', s('httpProtocol'));
  assign('tlsVersion', s('tlsVersion'));
  assign('clientTrustScore', n('clientTrustScore'));
  assign('verifiedBotCategory', s('verifiedBotCategory'));
  if (bm) out.botManagement = bm;
  return out;
}
