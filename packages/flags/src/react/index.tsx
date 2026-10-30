'use client';

import type { FlagValue } from '@hypdriv/core';
import { createContext, type ReactNode, useContext } from 'react';

const EMPTY: Readonly<Record<string, FlagValue>> = Object.freeze({});

const FlagsContext = createContext<Readonly<Record<string, FlagValue>>>(EMPTY);

export interface FlagsProviderProps {
  /** Public flag values for this request (the server passes `publicFlags(...)` or `hyp().flags`). */
  values: Record<string, FlagValue> | null | undefined;
  children?: ReactNode;
}

/**
 * Makes evaluated flags available to client components. Render it once near the root with the values
 * the server evaluated; nested providers override the outer ones.
 */
export function FlagsProvider({ values, children }: FlagsProviderProps) {
  return <FlagsContext.Provider value={values ?? EMPTY}>{children}</FlagsContext.Provider>;
}

/** All public flags for the current request (`{}` outside a provider). */
export function useFlags(): Readonly<Record<string, FlagValue>> {
  return useContext(FlagsContext);
}

/** One flag's value, or `fallback` when the flag is unknown or no provider is mounted. */
export function useFlag<T extends FlagValue>(name: string, fallback: T): T;
export function useFlag<T extends FlagValue = FlagValue>(name: string, fallback?: T): T | undefined;
export function useFlag(name: string, fallback?: FlagValue): FlagValue | undefined {
  const flags = useContext(FlagsContext);
  const value = flags[name];
  return value === undefined ? fallback : value;
}

export interface FlagProps {
  name: string;
  /** When set, children render only when the flag equals this value (string/number variants). */
  value?: FlagValue;
  /** Rendered when the flag is off (or does not equal `value`). */
  fallback?: ReactNode;
  children?: ReactNode;
}

/** Renders `children` when the flag is truthy (or equals `value`), otherwise `fallback`. */
export function Flag({ name, value, fallback = null, children }: FlagProps) {
  const flags = useContext(FlagsContext);
  const current = flags[name];
  const on = value === undefined ? Boolean(current) : current === value;
  return <>{on ? children : fallback}</>;
}
