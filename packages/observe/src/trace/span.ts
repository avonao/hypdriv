export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;
export type SpanStatus = 'unset' | 'ok' | 'error';
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

export interface SpanEvent {
  name: string;
  /** Epoch milliseconds. */
  time: number;
  attributes?: Attributes;
}

/** A minimal span compatible with OpenTelemetry semantics (architecture §8). Times are epoch milliseconds. */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly start: number;
  readonly end?: number;
  readonly attributes: Attributes;
  readonly events: SpanEvent[];
  readonly status: SpanStatus;
  readonly statusMessage?: string;
  /** Whether the span will be exported; children inherit it. */
  readonly sampled: boolean;
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attributes: Attributes): void;
  addEvent(name: string, attributes?: Attributes): void;
  setStatus(status: SpanStatus, message?: string): void;
  /** Records an exception as an `exception` event and marks the span as errored. */
  recordException(error: unknown): void;
  /** Ends the span (idempotent). `endTime` defaults to now. */
  end(endTime?: number): void;
  /** Elapsed milliseconds (until now while the span is open). */
  duration(): number;
  /** Registers a listener invoked once when the span ends (immediately when already ended). */
  onEnd(listener: (span: Span) => void): void;
}

export interface SpanInit {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: SpanKind;
  start: number;
  sampled: boolean;
  attributes?: Attributes;
  now: () => number;
  /** Called exactly once when the span ends. */
  onEnded: (span: SpanImpl) => void;
}

/** Caps that keep a single span from growing without bound. */
const MAX_ATTRIBUTES = 128;
const MAX_EVENTS = 128;
const MAX_STRING = 4096;

function clampValue(value: AttributeValue): AttributeValue {
  if (typeof value === 'string' && value.length > MAX_STRING) return value.slice(0, MAX_STRING);
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  return value;
}

export class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly start: number;
  readonly sampled: boolean;
  readonly attributes: Attributes = {};
  readonly events: SpanEvent[] = [];
  end_?: number;
  status: SpanStatus = 'unset';
  statusMessage?: string;
  private readonly now: () => number;
  private readonly onEnded: (span: SpanImpl) => void;
  private listeners: Array<(span: Span) => void> | null = null;

  constructor(init: SpanInit) {
    this.traceId = init.traceId;
    this.spanId = init.spanId;
    if (init.parentSpanId) this.parentSpanId = init.parentSpanId;
    this.name = init.name;
    this.kind = init.kind ?? 'internal';
    this.start = init.start;
    this.sampled = init.sampled;
    this.now = init.now;
    this.onEnded = init.onEnded;
    if (init.attributes) this.setAttributes(init.attributes);
  }

  get end(): number | undefined {
    return this.end_;
  }

  setAttribute(key: string, value: AttributeValue): void {
    if (value === undefined || value === null) return;
    if (!(key in this.attributes) && Object.keys(this.attributes).length >= MAX_ATTRIBUTES) return;
    this.attributes[key] = clampValue(value);
  }

  setAttributes(attributes: Attributes): void {
    for (const [k, v] of Object.entries(attributes)) this.setAttribute(k, v);
  }

  addEvent(name: string, attributes?: Attributes): void {
    if (this.events.length >= MAX_EVENTS) return;
    const event: SpanEvent = { name, time: this.now() };
    if (attributes) {
      event.attributes = {};
      for (const [k, v] of Object.entries(attributes)) if (v !== undefined && v !== null) event.attributes[k] = clampValue(v);
    }
    this.events.push(event);
  }

  setStatus(status: SpanStatus, message?: string): void {
    this.status = status;
    if (message !== undefined) this.statusMessage = message.slice(0, MAX_STRING);
    else if (status !== 'error') this.statusMessage = undefined;
  }

  recordException(error: unknown): void {
    const err = error instanceof Error ? error : null;
    const message = err ? err.message : String(error);
    const attrs: Attributes = { 'exception.message': message, 'exception.type': err?.name ?? typeof error };
    if (err?.stack) attrs['exception.stacktrace'] = err.stack;
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string' || typeof code === 'number') attrs['exception.code'] = code;
    this.addEvent('exception', attrs);
    this.setStatus('error', message);
  }

  end(endTime?: number): void {
    if (this.end_ !== undefined) return;
    this.end_ = Math.max(this.start, endTime ?? this.now());
    this.onEnded(this);
    const listeners = this.listeners;
    this.listeners = null;
    if (listeners) for (const l of listeners) l(this);
  }

  duration(): number {
    return (this.end_ ?? this.now()) - this.start;
  }

  onEnd(listener: (span: Span) => void): void {
    if (this.end_ !== undefined) {
      listener(this);
      return;
    }
    (this.listeners ??= []).push(listener);
  }

  /** Plain JSON view (used by the console exporter and tests). */
  toJSON() {
    return {
      traceId: this.traceId,
      spanId: this.spanId,
      ...(this.parentSpanId ? { parentSpanId: this.parentSpanId } : {}),
      name: this.name,
      kind: this.kind,
      start: this.start,
      end: this.end_,
      durationMs: this.end_ !== undefined ? this.end_ - this.start : undefined,
      status: this.status,
      ...(this.statusMessage ? { statusMessage: this.statusMessage } : {}),
      attributes: this.attributes,
      events: this.events,
    };
  }
}
