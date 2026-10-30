/** Coarse device class used for cache variance and flag targeting. */
export type DeviceClass = 'mobile' | 'desktop' | 'bot';

const BOT_UA =
  /bot\b|crawl|spider|slurp|headless|phantomjs|python-requests|python-urllib|curl\/|wget\/|go-http-client|scrapy|node-fetch|axios\/|okhttp|facebookexternalhit|lighthouse|pagespeed|preview\b|monitor/i;
const MOBILE_UA =
  /Mobi|Android|iPhone|iPod|iPad|Windows Phone|webOS|BlackBerry|BB10|Opera Mini|IEMobile|Silk\//i;

/**
 * Classifies the client from `Sec-CH-UA-Mobile` / `Sec-CH-UA-Platform` client hints and user-agent
 * heuristics. iPadOS Safari identifies as a desktop Mac; it is reported as `desktop` unless it
 * requests the mobile layout, which matches how sites should lay it out.
 */
export function deviceClass(headers: Headers): DeviceClass {
  const ua = headers.get('user-agent') ?? '';
  if (!ua.trim() || BOT_UA.test(ua)) return 'bot';
  const mobileHint = headers.get('sec-ch-ua-mobile');
  if (mobileHint === '?1') return 'mobile';
  if (mobileHint === '?0') {
    const platform = (headers.get('sec-ch-ua-platform') ?? '').replace(/"/g, '').toLowerCase();
    // A phone-sized Android browser requesting the desktop site still gets the desktop class.
    return platform === 'android' && MOBILE_UA.test(ua) && /Mobile/.test(ua) ? 'mobile' : 'desktop';
  }
  return MOBILE_UA.test(ua) ? 'mobile' : 'desktop';
}
