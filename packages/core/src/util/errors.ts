export type HypDrivErrorCode =
  | 'E_CONFIG'
  | 'E_MANIFEST'
  | 'E_MANIFEST_VERSION'
  | 'E_STAGE'
  | 'E_CACHE'
  | 'E_RATE_LIMIT'
  | 'E_CRYPTO'
  | 'E_VALIDATION'
  | 'E_UNAUTHORIZED'
  | 'E_FORBIDDEN'
  | 'E_NOT_FOUND'
  | 'E_TIMEOUT'
  | 'E_CIRCUIT_OPEN'
  | 'E_UPSTREAM'
  | 'E_UNSUPPORTED'
  | 'E_INTERNAL';

/** Error with a stable machine-readable code and optional structured details. */
export class HypDrivError extends Error {
  readonly code: HypDrivErrorCode;
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(
    code: HypDrivErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options: { status?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'HypDrivError';
    this.code = code;
    this.details = details;
    this.status = options.status ?? defaultStatus(code);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      status: this.status,
      details: this.details,
    };
  }
}

function defaultStatus(code: HypDrivErrorCode): number {
  switch (code) {
    case 'E_VALIDATION':
      return 400;
    case 'E_UNAUTHORIZED':
      return 401;
    case 'E_FORBIDDEN':
      return 403;
    case 'E_NOT_FOUND':
      return 404;
    case 'E_RATE_LIMIT':
      return 429;
    case 'E_TIMEOUT':
      return 504;
    case 'E_CIRCUIT_OPEN':
    case 'E_UPSTREAM':
      return 502;
    default:
      return 500;
  }
}

export function isHypDrivError(value: unknown, code?: HypDrivErrorCode): value is HypDrivError {
  return value instanceof HypDrivError && (code === undefined || value.code === code);
}

/** Narrow unknown thrown values into an Error without losing information. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

export function assert(
  condition: unknown,
  message: string,
  code: HypDrivErrorCode = 'E_INTERNAL',
): asserts condition {
  if (!condition) throw new HypDrivError(code, message);
}
