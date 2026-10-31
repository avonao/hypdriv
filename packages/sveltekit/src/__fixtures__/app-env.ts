// Test stand-in for SvelteKit's `$app/env` (aliased in vitest.config.ts): live bindings tests can flip.
export let building = false;
export let dev = false;
export const browser = false;
export const version = 'test';

export function setBuilding(value: boolean): void {
  building = value;
}

export function setDev(value: boolean): void {
  dev = value;
}
