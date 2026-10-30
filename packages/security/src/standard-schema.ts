/**
 * Minimal structural copy of the Standard Schema V1 interface (https://standardschema.dev).
 *
 * The specification is designed to be vendored: any library that implements `~standard` (Zod 3.24+,
 * Valibot 1+, ArkType 2+, Effect Schema, …) is assignable to these types without importing
 * `@standard-schema/spec`, which keeps the package free of type-level dependencies.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1Props<Input, Output>;
}

export interface StandardSchemaV1Props<Input = unknown, Output = Input> {
  readonly version: 1;
  readonly vendor: string;
  readonly validate: (
    value: unknown,
    options?: { readonly libraryOptions?: Record<string, unknown> | undefined } | undefined,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
  readonly types?: { readonly input: Input; readonly output: Output } | undefined;
}

export type StandardSchemaV1Result<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaV1Issue> };

export interface StandardSchemaV1Issue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** Output type of a Standard Schema. */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['output'];

/** Input type of a Standard Schema. */
export type InferInput<Schema extends StandardSchemaV1> = NonNullable<Schema['~standard']['types']>['input'];

/** Field errors keyed by dotted path; issues without a path land under `_form`. */
export type FieldErrors = Record<string, string[]>;

/** Key used for issues that carry no path. */
export const FORM_ERROR_KEY = '_form';

/** Groups Standard Schema issues by dotted path. */
export function issuesToFieldErrors(issues: ReadonlyArray<StandardSchemaV1Issue>): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    const path = (issue.path ?? [])
      .map((seg) => (typeof seg === 'object' && seg !== null && 'key' in seg ? seg.key : seg))
      .map((key) => String(key))
      .join('.');
    const key = path || FORM_ERROR_KEY;
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * Runs a Standard Schema and returns either the parsed value or grouped field errors.
 * Never throws for validation failures; schema exceptions propagate.
 */
export async function validateWithSchema<Output>(
  schema: StandardSchemaV1<unknown, Output>,
  value: unknown,
): Promise<{ ok: true; value: Output } | { ok: false; fieldErrors: FieldErrors; message: string }> {
  const result = await schema['~standard'].validate(value);
  if (result.issues) {
    const fieldErrors = issuesToFieldErrors(result.issues);
    const first = result.issues[0];
    return { ok: false, fieldErrors, message: first ? first.message : 'Invalid input' };
  }
  return { ok: true, value: result.value };
}

/** `true` when the value looks like a Standard Schema. */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { '~standard'?: { validate?: unknown } })['~standard']?.validate === 'function'
  );
}
