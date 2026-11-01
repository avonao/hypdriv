import { parseDuration, parseSize } from '../util/units';
import type { HypDrivConfig } from './types';

export interface ConfigDiagnostic {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

type Check = (value: unknown, path: string, out: ConfigDiagnostic[]) => void;

export const ROOT_KEYS = [
  'site',
  'security',
  'cache',
  'performance',
  'observe',
  'purser',
  'flags',
  'live',
  'images',
  'jobs',
  'budgets',
  'platform',
  'cloudflare',
  'vercel',
  'devtools',
  'i18n',
  'redirects',
  'maintenance',
  'stages',
] as const;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function error(out: ConfigDiagnostic[], path: string, message: string) {
  out.push({ severity: 'error', path, message });
}
function warning(out: ConfigDiagnostic[], path: string, message: string) {
  out.push({ severity: 'warning', path, message });
}

function checkEnum<T extends string>(values: readonly T[]): Check {
  return (v, path, out) => {
    if (v !== undefined && !values.includes(v as T))
      error(out, path, `must be one of ${values.map((x) => JSON.stringify(x)).join(', ')}`);
  };
}

const checkBoolean: Check = (v, path, out) => {
  if (v !== undefined && typeof v !== 'boolean') error(out, path, 'must be a boolean');
};

const checkString: Check = (v, path, out) => {
  if (v !== undefined && typeof v !== 'string') error(out, path, 'must be a string');
};

const checkStringArray: Check = (v, path, out) => {
  if (v === undefined) return;
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string'))
    error(out, path, 'must be an array of strings');
};

const checkDuration: Check = (v, path, out) => {
  if (v === undefined) return;
  try {
    parseDuration(v as number | string, 0);
  } catch (e) {
    error(out, path, (e as Error).message);
  }
};

const checkSize: Check = (v, path, out) => {
  if (v === undefined) return;
  try {
    parseSize(v as number | string, 0);
  } catch (e) {
    error(out, path, (e as Error).message);
  }
};

const checkNumber =
  (min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): Check =>
  (v, path, out) => {
    if (v === undefined) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) return error(out, path, 'must be a finite number');
    if (v < min || v > max) error(out, path, `must be between ${min} and ${max}`);
  };

const checkRoutePattern: Check = (v, path, out) => {
  if (v === undefined) return;
  const items = Array.isArray(v) ? v : [v];
  for (const [i, item] of items.entries()) {
    const p = Array.isArray(v) ? `${path}[${i}]` : path;
    if (item instanceof RegExp) continue;
    if (typeof item !== 'string')
      return error(out, p, 'must be a path pattern string, a RegExp, or an array of them');
    if (!item.startsWith('/') && !item.startsWith('^'))
      error(out, p, 'path patterns must start with "/" (or "^" for regex strings)');
  }
};

function checkObjectShape(shape: Record<string, Check>, options: { allowUnknown?: boolean } = {}): Check {
  return (v, path, out) => {
    if (v === undefined) return;
    if (!isObject(v)) return error(out, path, 'must be an object');
    for (const [key, check] of Object.entries(shape)) check(v[key], `${path}.${key}`, out);
    if (!options.allowUnknown) {
      for (const key of Object.keys(v))
        if (!(key in shape)) warning(out, `${path}.${key}`, 'unknown option (ignored)');
    }
  };
}

function boolOr(shapeCheck: Check): Check {
  return (v, path, out) => {
    if (v === undefined || typeof v === 'boolean') return;
    shapeCheck(v, path, out);
  };
}

function arrayOf(itemCheck: Check): Check {
  return (v, path, out) => {
    if (v === undefined) return;
    if (!Array.isArray(v)) return error(out, path, 'must be an array');
    v.forEach((item, i) => itemCheck(item, `${path}[${i}]`, out));
  };
}

function recordOf(valueCheck: Check): Check {
  return (v, path, out) => {
    if (v === undefined) return;
    if (!isObject(v)) return error(out, path, 'must be an object');
    for (const [k, item] of Object.entries(v)) valueCheck(item, `${path}.${k}`, out);
  };
}

const checkCspDirectives: Check = (v, path, out) => {
  if (v === undefined) return;
  if (!isObject(v)) return error(out, path, 'must be an object of directive → source list');
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === 'boolean') continue;
    if (!Array.isArray(val) || val.some((x) => typeof x !== 'string'))
      error(out, `${path}.${k}`, 'must be an array of strings or a boolean');
    if (!/^[a-z-]+$/.test(k)) error(out, `${path}.${k}`, 'directive names are lowercase with dashes');
  }
};

const cspCheck = boolOr(
  checkObjectShape({
    mode: checkEnum(['auto', 'nonce', 'hash', 'off']),
    reportOnly: (v, p, o) => {
      if (v !== undefined && typeof v !== 'boolean' && v !== 'both')
        error(o, p, 'must be a boolean or "both"');
    },
    directives: checkCspDirectives,
    allow: checkObjectShape({
      scripts: checkStringArray,
      styles: checkStringArray,
      images: checkStringArray,
      fonts: checkStringArray,
      connect: checkStringArray,
      frames: checkStringArray,
      media: checkStringArray,
      workers: checkStringArray,
      frameAncestors: checkStringArray,
      formAction: checkStringArray,
    }),
    routes: arrayOf(
      checkObjectShape({
        match: checkRoutePattern,
        directives: checkCspDirectives,
        mode: checkEnum(['nonce', 'hash', 'off']),
        reportOnly: checkBoolean,
      }),
    ),
    strictDynamic: checkBoolean,
    unsafeInlineStyles: checkBoolean,
    devUnsafeEval: checkBoolean,
    reportTo: (v, p, o) => {
      if (v !== undefined && v !== false && typeof v !== 'string')
        error(o, p, 'must be a string path/URL or false');
    },
    reportingEndpoints: checkBoolean,
    trustedTypes: (v, p, o) => {
      if (v === undefined || typeof v === 'boolean') return;
      checkObjectShape({ policies: checkStringArray, allowDuplicates: checkBoolean })(v, p, o);
    },
    upgradeInsecureRequests: checkBoolean,
    nonceHeader: checkString,
  }),
);

const headersShape = {
  hsts: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === undefined || v === false) return;
    checkObjectShape({ maxAge: checkDuration, includeSubDomains: checkBoolean, preload: checkBoolean })(
      v,
      p,
      o,
    );
  },
  coop: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkEnum(['same-origin', 'same-origin-allow-popups', 'unsafe-none', 'noopener-allow-popups'])(v, p, o);
  },
  corp: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkEnum(['same-origin', 'same-site', 'cross-origin'])(v, p, o);
  },
  coep: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkEnum(['require-corp', 'credentialless'])(v, p, o);
  },
  referrerPolicy: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkString(v, p, o);
  },
  permissionsPolicy: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === undefined || v === false) return;
    recordOf(checkStringArray)(v, p, o);
  },
  frameOptions: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkEnum(['DENY', 'SAMEORIGIN'])(v, p, o);
  },
  noSniff: checkBoolean,
  dnsPrefetchControl: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkEnum(['on', 'off'])(v, p, o);
  },
  permittedCrossDomainPolicies: (v: unknown, p: string, o: ConfigDiagnostic[]) => {
    if (v === false) return;
    checkEnum(['none', 'master-only', 'by-content-type', 'all'])(v, p, o);
  },
  originAgentCluster: checkBoolean,
  stripFingerprints: checkBoolean,
  extra: recordOf(checkString),
};

const rateLimitPolicyCheck = checkObjectShape({
  id: (v, p, o) => {
    if (typeof v !== 'string' || !v) error(o, p, 'is required');
  },
  match: (v, p, o) => {
    if (v === undefined) return error(o, p, 'is required');
    checkRoutePattern(v, p, o);
  },
  methods: checkStringArray,
  limit: (v, p, o) => {
    if (typeof v !== 'number' || v <= 0) error(o, p, 'must be a positive number');
  },
  window: (v, p, o) => {
    if (v === undefined) return error(o, p, 'is required');
    checkDuration(v, p, o);
  },
  burst: checkNumber(0),
  algorithm: checkEnum(['fixed-window', 'sliding-window', 'token-bucket']),
  key: (v, p, o) => {
    const valid = ['ip', 'session', 'user', 'api-key', 'path', 'global'];
    const items = Array.isArray(v) ? v : v === undefined ? [] : [v];
    for (const k of items)
      if (!valid.includes(k as string)) error(o, p, `must be one of ${valid.join(', ')}`);
  },
  store: checkEnum(['auto', 'memory', 'cache-api', 'kv', 'durable-object', 'binding']),
  apiKeyHeader: checkString,
  sessionCookie: checkString,
  userHeader: checkString,
  response: checkObjectShape({
    status: checkNumber(400, 599),
    body: () => {},
    headers: recordOf(checkString),
  }),
  headers: checkBoolean,
  skip: (v, p, o) => {
    if (v !== undefined && typeof v !== 'function') error(o, p, 'must be a function');
  },
});

const edgeCachePolicyCheck = checkObjectShape({
  id: checkString,
  match: (v, p, o) => {
    if (v === undefined) return error(o, p, 'is required');
    checkRoutePattern(v, p, o);
  },
  methods: arrayOf(checkEnum(['GET', 'HEAD'])),
  ttl: (v, p, o) => {
    if (v === undefined) return error(o, p, 'is required');
    checkDuration(v, p, o);
  },
  swr: checkDuration,
  staleIfError: checkDuration,
  tags: checkStringArray,
  vary: checkObjectShape({
    headers: checkStringArray,
    cookies: checkStringArray,
    geo: arrayOf(checkEnum(['country', 'region', 'city', 'continent', 'timezone', 'colo'])),
    flags: checkStringArray,
    experiments: checkBoolean,
    language: checkBoolean,
    device: checkBoolean,
  }),
  bypass: checkObjectShape({
    cookies: checkStringArray,
    headers: checkStringArray,
    query: checkStringArray,
    when: (v, p, o) => {
      if (v !== undefined && typeof v !== 'function') error(o, p, 'must be a function');
    },
  }),
  respectOrigin: checkBoolean,
  includeRsc: checkBoolean,
  statuses: arrayOf(checkNumber(100, 599)),
  keyQuery: (v, p, o) => {
    if (v === undefined || v === 'all' || v === 'none') return;
    checkStringArray(v, p, o);
  },
});

const rootCheck = checkObjectShape({
  site: checkObjectShape({
    name: checkString,
    origin: checkString,
    basePath: checkString,
    trailingSlash: checkBoolean,
  }),
  security: checkObjectShape({
    headers: boolOr(
      checkObjectShape({
        ...headersShape,
        routes: arrayOf(
          checkObjectShape({ match: checkRoutePattern, headers: checkObjectShape(headersShape) }),
        ),
      }),
    ),
    csp: cspCheck,
    rateLimit: arrayOf(rateLimitPolicyCheck),
    bots: boolOr(
      checkObjectShape({
        verified: checkEnum(['allow', 'challenge', 'block', 'tarpit', 'log']),
        likelyAutomated: checkEnum(['allow', 'challenge', 'block', 'tarpit', 'log']),
        definitelyAutomated: checkEnum(['allow', 'challenge', 'block', 'tarpit', 'log']),
        scoreThreshold: checkNumber(1, 99),
        honeypots: checkStringArray,
        blockUserAgents: () => {},
        allowUserAgents: () => {},
        exempt: checkRoutePattern,
        secFetchChecks: checkBoolean,
        turnstile: checkObjectShape({
          siteKey: checkString,
          siteKeyEnv: checkString,
          secretEnv: checkString,
          action: checkString,
        }),
        tarpitMs: checkNumber(0, 10000),
      }),
    ),
    shield: boolOr(
      checkObjectShape({
        methods: checkStringArray,
        maxBody: (v, p, o) => {
          if (v === undefined) return;
          if (Array.isArray(v))
            return arrayOf(checkObjectShape({ match: checkRoutePattern, limit: checkSize }))(v, p, o);
          checkSize(v, p, o);
        },
        maxUrlLength: checkNumber(256, 65536),
        blockTraversal: checkBoolean,
        blockedPaths: checkStringArray,
        enforceHost: (v, p, o) => {
          if (v === undefined || typeof v === 'boolean') return;
          checkStringArray(v, p, o);
        },
      }),
    ),
    csrf: boolOr(
      checkObjectShape({
        cookie: checkString,
        header: checkString,
        match: checkRoutePattern,
        exempt: checkRoutePattern,
        acceptSecFetchSite: checkBoolean,
      }),
    ),
    secretsScan: boolOr(
      checkObjectShape({
        patterns: arrayOf(
          checkObjectShape({ id: checkString, pattern: () => {}, severity: checkEnum(['error', 'warn']) }),
        ),
        ignore: checkStringArray,
        envAllowlist: checkStringArray,
        publicPrefixes: checkStringArray,
        minValueLength: checkNumber(4, 256),
        failOnFinding: checkBoolean,
      }),
    ),
    sri: boolOr(checkObjectShape({ algorithm: checkEnum(['sha256', 'sha384', 'sha512']) })),
    sessions: checkObjectShape({
      cookie: checkString,
      secretEnv: checkString,
      previousSecretEnvs: checkStringArray,
      ttl: checkDuration,
      sliding: checkBoolean,
      sameSite: checkEnum(['lax', 'strict', 'none']),
      secure: checkBoolean,
      path: checkString,
      domain: checkString,
    }),
    internalAuth: checkObjectShape({ secretEnv: checkString, ttl: checkDuration, header: checkString }),
    trustedProxies: checkNumber(0, 10),
  }),
  cache: checkObjectShape({
    edge: boolOr(
      checkObjectShape({
        policies: arrayOf(edgeCachePolicyCheck),
        infer: checkBoolean,
        inferredStatic: checkObjectShape({
          ttl: checkDuration,
          swr: checkDuration,
          staleIfError: checkDuration,
        }),
        inferredShell: (v, p, o) => {
          if (v === undefined || v === false) return;
          checkObjectShape({ ttl: checkDuration, swr: checkDuration })(v, p, o);
        },
        bypass: checkObjectShape({
          cookies: checkStringArray,
          headers: checkStringArray,
          query: checkStringArray,
        }),
        store: checkEnum(['auto', 'cache-api', 'memory', 'kv', 'tiered']),
        negativeTtl: checkDuration,
        ignoredQuery: checkStringArray,
        maxBodySize: checkSize,
        purge: checkObjectShape({
          zoneIdEnv: checkString,
          tokenEnv: checkString,
          index: checkEnum(['auto', 'kv', 'durable-object', 'none']),
        }),
        emitTagHeaders: checkBoolean,
        memoryTtl: checkDuration,
        debugHeader: checkBoolean,
      }),
    ),
    warm: checkObjectShape({
      routes: checkStringArray,
      onDeploy: checkBoolean,
      cron: checkString,
      concurrency: checkNumber(1, 64),
      hot: boolOr(
        checkObjectShape({
          limit: checkNumber(1, 200),
          days: checkNumber(1, 90),
          minViews: checkNumber(1, 1_000_000),
          dataset: (v, p, o) => {
            if (v === undefined) return;
            if (typeof v !== 'string' || !/^[A-Za-z0-9_]+$/.test(v))
              error(o, p, 'must be an Analytics Engine dataset name (letters, digits and underscores)');
          },
          datasetEnv: checkString,
          accountIdEnv: checkString,
          apiTokenEnv: checkString,
        }),
      ),
    }),
  }),
  performance: checkObjectShape({
    earlyHints: boolOr(
      checkObjectShape({
        preconnect: checkStringArray,
        fonts: checkBoolean,
        styles: checkBoolean,
        scripts: (v, p, o) => {
          if (v !== undefined && typeof v !== 'boolean' && v !== 'main')
            error(o, p, 'must be a boolean or "main"');
        },
        purser: checkBoolean,
        maxLinks: checkNumber(1, 64),
        onRsc: checkBoolean,
      }),
    ),
    speculation: boolOr(
      checkObjectShape({
        prerender: (v, p, o) => {
          if (v === undefined || v === false) return;
          checkObjectShape({
            eagerness: checkEnum(['immediate', 'eager', 'moderate', 'conservative']),
            include: checkStringArray,
            exclude: checkStringArray,
            topN: checkNumber(0, 50),
          })(v, p, o);
        },
        prefetch: (v, p, o) => {
          if (v === undefined || v === false) return;
          checkObjectShape({
            eagerness: checkEnum(['immediate', 'eager', 'moderate', 'conservative']),
            include: checkStringArray,
            exclude: checkStringArray,
          })(v, p, o);
        },
        exclude: checkStringArray,
        useGraph: checkBoolean,
        inject: checkEnum(['auto', 'edge', 'component', 'off']),
      }),
    ),
    priorityHints: (v, p, o) => {
      if (v === undefined || v === false) return;
      checkObjectShape({ selectors: checkStringArray })(v, p, o);
    },
    skewProtection: boolOr(checkObjectShape({ deploymentId: checkString, reloadOnMismatch: checkBoolean })),
    fetch: checkObjectShape({
      timeout: checkDuration,
      retries: checkNumber(0, 10),
      retryOn: arrayOf(checkNumber(100, 599)),
      backoff: checkObjectShape({ baseMs: checkNumber(0), maxMs: checkNumber(0), jitter: checkBoolean }),
      circuitBreaker: (v, p, o) => {
        if (v === undefined || v === false) return;
        checkObjectShape({
          failureThreshold: checkNumber(1),
          cooldown: checkDuration,
          halfOpenMax: checkNumber(1),
        })(v, p, o);
      },
    }),
    html: checkObjectShape({ stripComments: checkBoolean, collapseWhitespace: checkBoolean }),
  }),
  observe: checkObjectShape({
    tracing: boolOr(
      checkObjectShape({
        exporter: checkEnum(['console', 'otlp', 'analytics-engine', 'none']),
        serviceName: checkString,
        sampleRate: checkNumber(0, 1),
        otlp: checkObjectShape({
          url: checkString,
          headers: recordOf(checkString),
          headersEnv: checkString,
          timeout: checkDuration,
        }),
        analyticsEngineBinding: checkString,
        propagate: checkBoolean,
      }),
    ),
    logging: checkObjectShape({
      level: checkEnum(['debug', 'info', 'warn', 'error', 'silent']),
      format: checkEnum(['json', 'pretty']),
      redact: checkStringArray,
      sampleRate: checkNumber(0, 1),
      requests: checkBoolean,
    }),
    serverTiming: (v, p, o) => {
      if (v === undefined || typeof v === 'boolean' || v === 'compact' || v === 'verbose') return;
      error(o, p, 'must be a boolean, "compact" or "verbose"');
    },
    vitals: boolOr(
      checkObjectShape({
        endpoint: checkString,
        sampleRate: checkNumber(0, 1),
        sink: checkEnum(['log', 'analytics-engine', 'none']),
        analyticsEngineBinding: checkString,
        attribution: checkBoolean,
        dashboard: boolOr(
          checkObjectShape({
            tokenEnv: checkString,
            accountIdEnv: checkString,
            apiTokenEnv: checkString,
            dataset: (v, p, o) => {
              if (v === undefined) return;
              if (typeof v !== 'string' || !/^[A-Za-z0-9_]+$/.test(v))
                error(o, p, 'must be an Analytics Engine dataset name (letters, digits and underscores)');
            },
            datasetEnv: checkString,
            days: checkNumber(1, 90),
            cacheSeconds: checkNumber(0, 3600),
            sessionMinutes: checkNumber(1, 1440),
            memoryCapacity: checkNumber(0, 100_000),
          }),
        ),
      }),
    ),
    errors: checkObjectShape({ sink: checkEnum(['log', 'otlp', 'none']), includeStack: checkBoolean }),
  }),
  purser: (v, p, o) => {
    if (v === undefined || v === false) return;
    checkObjectShape({
      enabled: checkBoolean,
      project: checkString,
      src: checkStringArray,
      tokens: checkString,
      out: checkString,
      prefix: checkString,
      salt: checkString,
      packageName: checkString,
      cssModule: checkString,
      layers: checkObjectShape({ tokens: checkString, globals: checkString, atoms: checkString }),
      verify: checkEnum(['error', 'warn', 'off']),
      usageReport: checkBoolean,
      theme: checkObjectShape({
        cookie: checkString,
        axes: recordOf(
          checkObjectShape({
            cookie: checkString,
            classes: (v2, p2, o2) => {
              if (!isObject(v2)) return error(o2, p2, 'must be an object of value → class name (or null)');
              for (const [k, cls] of Object.entries(v2))
                if (cls !== null && typeof cls !== 'string')
                  error(o2, `${p2}.${k}`, 'must be a string or null');
            },
            default: (v2, p2, o2) => {
              if (typeof v2 !== 'string') error(o2, p2, 'is required');
            },
            clientHint: checkObjectShape({
              hint: checkEnum(['prefers-color-scheme', 'prefers-contrast', 'prefers-reduced-motion']),
              values: recordOf(checkString),
            }),
          }),
        ),
        fallbackScript: checkBoolean,
        acceptClientHints: checkBoolean,
      }),
      audit: checkObjectShape({
        widths: arrayOf(checkNumber(200, 5000)),
        states: arrayOf(checkEnum(['default', 'hover', 'focus'])),
        routes: checkStringArray,
      }),
      earlyHints: checkBoolean,
      checkInDoctor: checkBoolean,
    })(v, p, o);
  },
  flags: checkObjectShape({
    definitions: recordOf(
      checkObjectShape({
        description: checkString,
        default: (v, p, o) => {
          if (!['boolean', 'string', 'number'].includes(typeof v))
            error(o, p, 'is required (boolean, string or number)');
        },
        rules: arrayOf(
          checkObjectShape({
            when: checkObjectShape({
              country: checkStringArray,
              continent: checkStringArray,
              path: checkStringArray,
              cookie: () => {},
              header: () => {},
              device: checkEnum(['mobile', 'desktop', 'bot']),
              from: checkString,
              until: checkString,
              flag: () => {},
            }),
            percentage: checkNumber(0, 100),
            value: (v, p, o) => {
              if (!['boolean', 'string', 'number'].includes(typeof v))
                error(o, p, 'is required (boolean, string or number)');
            },
          }),
        ),
        experiment: checkObjectShape({
          variants: (v, p, o) => {
            if (!v || typeof v !== 'object' || Array.isArray(v))
              error(o, p, 'is required (an object of variant name → weight)');
          },
          traffic: checkNumber(0, 100),
          when: () => {},
          salt: checkString,
          status: checkEnum(['running', 'paused', 'concluded']),
          winner: checkString,
          expose: checkStringArray,
        }),
        serverOnly: checkBoolean,
      }),
    ),
    provider: checkEnum(['static', 'env', 'kv', 'openfeature']),
    envVar: checkString,
    kvBinding: checkString,
    kvKey: checkString,
    idCookie: checkString,
    experimentCookie: checkString,
    exposures: checkEnum(['auto', 'log', 'analytics-engine', 'none']),
    exposuresBinding: checkString,
    header: checkString,
    queryOverrides: (v, p, o) => {
      if (v !== undefined && typeof v !== 'boolean' && v !== 'development')
        error(o, p, 'must be a boolean or "development"');
    },
    refresh: checkDuration,
  }),
  live: checkObjectShape({
    enabled: checkBoolean,
    binding: checkString,
    transport: checkEnum(['auto', 'sse', 'websocket', 'polling']),
    pollInterval: checkDuration,
    path: checkString,
    maxSubscribers: checkNumber(1),
    retain: checkNumber(0, 1000),
    authorize: (v, p, o) => {
      if (v !== undefined && typeof v !== 'function') error(o, p, 'must be a function');
    },
  }),
  images: checkObjectShape({
    loader: checkEnum(['auto', 'cloudflare', 'next', 'none']),
    cdnCgi: (v, p, o) => {
      if (v !== undefined && typeof v !== 'boolean' && v !== 'auto')
        error(o, p, 'must be a boolean or "auto"');
    },
    quality: checkNumber(1, 100),
    formats: arrayOf(checkEnum(['avif', 'webp', 'auto'])),
    placeholders: checkObjectShape({
      enabled: checkBoolean,
      file: checkString,
      size: checkNumber(4, 64),
      sources: checkStringArray,
      engine: checkEnum(['auto', 'sharp', 'portable']),
      format: checkEnum(['auto', 'webp', 'png']),
      quality: checkNumber(1, 100),
      accuracy: checkEnum(['fast', 'exact']),
    }),
    allowedHosts: checkStringArray,
  }),
  jobs: checkObjectShape({
    cron: recordOf(
      checkObjectShape({
        cron: checkString,
        path: checkString,
        timeout: checkDuration,
        method: checkEnum(['GET', 'POST']),
      }),
    ),
    queues: recordOf(
      checkObjectShape({
        path: checkString,
        retry: checkEnum(['failed', 'all', 'none']),
        maxConcurrency: checkNumber(1, 100),
        queues: checkStringArray,
      }),
    ),
    email: checkObjectShape({ path: checkString }),
    basePath: checkString,
  }),
  budgets: checkObjectShape({
    routes: recordOf(checkObjectShape({ js: checkSize, css: checkSize, html: checkSize })),
    worker: checkObjectShape({ raw: checkSize, gzip: checkSize, startupMs: checkNumber(1) }),
    totalJs: checkSize,
    failOn: checkEnum(['error', 'warn', 'never']),
    snapshotDir: checkString,
  }),
  cloudflare: checkObjectShape({
    bindings: checkObjectShape({
      kv: checkString,
      tagIndex: checkString,
      limiter: checkString,
      channel: checkString,
      rateLimit: checkString,
      analyticsEngine: checkString,
      images: checkString,
      assets: checkString,
      queues: recordOf(checkString),
      ai: checkString,
    }),
    smartPlacement: checkBoolean,
    runWorkerFirst: (v, p, o) => {
      if (v === undefined || typeof v === 'boolean') return;
      checkStringArray(v, p, o);
    },
    internalPathPrefix: (v, p, o) => {
      if (v === undefined) return;
      if (typeof v !== 'string' || !v.startsWith('/') || v.endsWith('/'))
        error(o, p, 'must start with "/" and not end with "/"');
    },
    skipStaticAssets: checkBoolean,
    health: checkBoolean,
  }),
  platform: checkEnum(['auto', 'cloudflare', 'vercel', 'node']),
  vercel: checkObjectShape({
    cdn: boolOr(checkObjectShape({ downstream: checkBoolean })),
    globalConfig: boolOr(checkObjectShape({ connectionEnv: checkStringArray })),
    redis: boolOr(
      checkObjectShape({ urlEnv: checkStringArray, tokenEnv: checkStringArray, prefix: checkString }),
    ),
    firewall: checkObjectShape({ rateLimitRules: recordOf(checkString) }),
    botId: boolOr(checkObjectShape({ checkLevel: checkEnum(['basic', 'deepAnalysis']) })),
    purge: checkObjectShape({ tokenEnv: checkString, teamIdEnv: checkString, projectIdEnv: checkString }),
    cronSecretEnv: checkString,
    queues: recordOf(checkString),
  }),
  devtools: boolOr(
    checkObjectShape({
      enabled: (v, p, o) => {
        if (v !== undefined && typeof v !== 'boolean' && v !== 'development' && v !== 'preview')
          error(o, p, 'must be a boolean, "development" or "preview"');
      },
      hotkey: checkString,
      position: checkEnum(['bottom-left', 'bottom-right', 'top-left', 'top-right']),
      endpoint: checkString,
    }),
  ),
  i18n: checkObjectShape({
    locales: (v, p, o) => {
      if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== 'string'))
        error(o, p, 'must be a non-empty array of locale strings');
    },
    defaultLocale: (v, p, o) => {
      if (typeof v !== 'string') error(o, p, 'is required');
    },
    strategy: checkEnum(['prefix', 'prefix-except-default', 'header', 'cookie']),
    cookie: checkString,
    geoMap: recordOf(checkString),
    redirect: checkBoolean,
    header: checkString,
  }),
  redirects: checkObjectShape({
    rules: arrayOf(
      checkObjectShape({
        from: (v, p, o) => {
          if (typeof v !== 'string' || !v.startsWith('/')) error(o, p, 'must be a path starting with "/"');
        },
        to: (v, p, o) => {
          if (typeof v !== 'string') error(o, p, 'is required');
        },
        status: checkEnum([301, 302, 307, 308] as unknown as readonly string[]),
        preserveQuery: checkBoolean,
        host: checkString,
      }),
    ),
    kvBinding: checkString,
    kvKey: checkString,
    cacheTtl: checkDuration,
    canonicalHost: checkString,
    forceHttps: checkBoolean,
  }),
  maintenance: checkObjectShape({
    enabled: (v, p, o) => {
      if (v !== undefined && typeof v !== 'boolean' && v !== 'env') error(o, p, 'must be a boolean or "env"');
    },
    envVar: checkString,
    kvBinding: checkString,
    kvKey: checkString,
    allowIps: checkStringArray,
    bypassCookie: checkString,
    bypassCookieValue: checkString,
    bypassPaths: checkStringArray,
    html: checkString,
    retryAfter: checkDuration,
    status: checkEnum([503, 200] as unknown as readonly string[]),
  }),
  stages: checkObjectShape({ disable: checkStringArray, order: checkStringArray }),
});

/** Validates a user configuration object. Returns diagnostics; errors mean the config must not be used. */
export function validateConfig(input: unknown): ConfigDiagnostic[] {
  const out: ConfigDiagnostic[] = [];
  if (!isObject(input)) {
    error(out, 'config', 'must be an object (did you forget `export default defineConfig({...})`?)');
    return out;
  }
  rootCheck(input, 'config', out);
  semanticChecks(input as HypDrivConfig, out);
  return out.map((d) => ({ ...d, path: d.path.replace(/^config\.?/, '') || '(root)' }));
}

function semanticChecks(config: HypDrivConfig, out: ConfigDiagnostic[]) {
  for (const [i, p] of (config.security?.rateLimit ?? []).entries()) {
    if (p.store === 'binding') {
      const w = (() => {
        try {
          return parseDuration(p.window, 60);
        } catch {
          return 60;
        }
      })();
      if (w !== 10 && w !== 60)
        error(
          out,
          `config.security.rateLimit[${i}].window`,
          'the Cloudflare Rate Limiting binding supports only 10s or 60s windows',
        );
    }
  }
  const ids = new Set<string>();
  for (const [i, p] of (config.security?.rateLimit ?? []).entries()) {
    if (ids.has(p.id)) error(out, `config.security.rateLimit[${i}].id`, `duplicate policy id "${p.id}"`);
    ids.add(p.id);
  }
  if (config.i18n && !config.i18n.locales?.includes(config.i18n.defaultLocale)) {
    error(out, 'config.i18n.defaultLocale', 'must be included in `locales`');
  }
  const csp = config.security?.csp;
  if (csp && typeof csp === 'object' && csp.trustedTypes) {
    warning(
      out,
      'config.security.csp.trustedTypes',
      'Trusted Types enforcement can break third-party scripts; roll out with `reportOnly: true` first',
    );
  }
  const headers = config.security?.headers;
  if (headers && typeof headers === 'object' && headers.coep) {
    warning(
      out,
      'config.security.headers.coep',
      'COEP requires CORP/CORS headers on every cross-origin resource; verify embeds before enabling',
    );
  }
  const sessions = config.security?.sessions;
  if (sessions?.sameSite === 'none' && sessions.secure === false) {
    error(out, 'config.security.sessions', '`sameSite: "none"` requires `secure: true`');
  }
  for (const [name, job] of Object.entries(config.jobs?.cron ?? {})) {
    if (!/^(\S+\s+){4}\S+$/.test(job.cron.trim()))
      error(out, `config.jobs.cron.${name}.cron`, 'must be a 5-field cron expression');
    if (!job.path.startsWith('/')) error(out, `config.jobs.cron.${name}.path`, 'must start with "/"');
  }
  for (const [name, def] of Object.entries(config.flags?.definitions ?? {})) {
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name))
      error(out, `config.flags.definitions.${name}`, 'flag names must be alphanumeric (plus _ . -)');
    if (def.experiment) validateExperiment(out, `config.flags.definitions.${name}`, name, def);
    for (const [i, rule] of (def.rules ?? []).entries()) {
      if (typeof rule.value !== typeof def.default) {
        warning(
          out,
          `config.flags.definitions.${name}.rules[${i}].value`,
          `type differs from the default (${typeof def.default})`,
        );
      }
    }
  }
}

/** Experiment names and variants travel in a cookie, so they stay URL-safe. */
const EXPERIMENT_TOKEN = /^[A-Za-z0-9_-]{1,48}$/;

function validateExperiment(
  out: ConfigDiagnostic[],
  path: string,
  name: string,
  def: NonNullable<NonNullable<HypDrivConfig['flags']>['definitions']>[string],
): void {
  const spec = def.experiment;
  if (!spec) return;
  if (!EXPERIMENT_TOKEN.test(name))
    error(
      out,
      path,
      'experiment names must be 1–48 letters, digits, "_" or "-" (they are stored in a cookie)',
    );
  const variants = Object.entries(spec.variants ?? {});
  if (variants.length < 2) error(out, `${path}.experiment.variants`, 'needs at least two variants');
  for (const [variant, weight] of variants) {
    if (!EXPERIMENT_TOKEN.test(variant))
      error(
        out,
        `${path}.experiment.variants.${variant}`,
        'variant names must be 1–48 letters, digits, "_" or "-"',
      );
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)
      error(out, `${path}.experiment.variants.${variant}`, 'the weight must be a positive number');
  }
  if (typeof def.default !== 'string' || !(def.default in (spec.variants ?? {})))
    error(
      out,
      `${path}.default`,
      `must be the control variant, one of: ${variants.map(([v]) => v).join(', ')}`,
    );
  if (spec.status === 'concluded' && spec.winner !== undefined && !(spec.winner in (spec.variants ?? {})))
    error(out, `${path}.experiment.winner`, 'must be one of the variants');
  if (spec.status === 'concluded' && spec.winner === undefined)
    warning(
      out,
      `${path}.experiment.winner`,
      'a concluded experiment without a winner serves the control to everyone',
    );
  if (def.rules?.length)
    warning(
      out,
      `${path}.rules`,
      'rules are ignored for an experiment; use experiment.when to pick the audience',
    );
}
