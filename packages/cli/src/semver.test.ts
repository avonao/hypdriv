import { describe, expect, it } from 'vitest';
import {
  atLeast,
  bumpRange,
  classifyUpdate,
  compareVersions,
  highestVersion,
  parseVersion,
  rangeBase,
} from './semver';

describe('semver', () => {
  it('parses and compares versions with prerelease precedence', () => {
    const v = (s: string) => parseVersion(s)!;
    expect(v('v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(v('16.4.3-canary.12+build')).toMatchObject({ prerelease: ['canary', '12'] });
    expect(parseVersion('latest')).toBeNull();
    expect(compareVersions(v('1.0.0-alpha'), v('1.0.0'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-alpha.2'), v('1.0.0-alpha.10'))).toBeLessThan(0);
    expect(compareVersions(v('1.0.0-beta'), v('1.0.0-alpha.1'))).toBeGreaterThan(0);
    expect(atLeast('20.9.0', '20.9.0')).toBe(true);
    expect(atLeast('20.8.1', '20.9.0')).toBe(false);
  });

  it('extracts simple range bases', () => {
    expect(rangeBase('^1.2.3')).toMatchObject({ operator: '^', version: { major: 1, minor: 2, patch: 3 } });
    expect(rangeBase('~0.4')).toMatchObject({ operator: '~', version: { major: 0, minor: 4, patch: 0 } });
    expect(rangeBase('>=16.0.0')).toMatchObject({ operator: '>=' });
    expect(rangeBase('1.x')).toMatchObject({ operator: '^', version: { major: 1 } });
    expect(rangeBase('>=1 <2')).toBeNull();
    expect(rangeBase('^1 || ^2')).toBeNull();
    expect(rangeBase('workspace:*')).toBeNull();
  });

  it.each([
    ['^1.2.3', '1.2.4', 'patch'],
    ['^1.2.3', '1.3.0', 'minor'],
    ['^1.2.3', '2.0.0', 'major'],
    ['~1.2.3', '1.2.3', 'current'],
    ['1.2.3', '1.2.2', 'current'],
    ['^1.2.3', '1.3.0-beta.1', 'current'],
    ['^1.3.0-beta.1', '1.3.0-beta.2', 'patch'],
    ['^1.3.0-beta.1', '1.3.0', 'patch'],
    ['^0.23.4', '0.24.0', 'minor'],
    ['>=1 <2', '1.5.0', 'unknown'],
    ['^1.0.0', null, 'unknown'],
  ])('classifies %s → %s as %s', (current, latest, diff) => {
    expect(classifyUpdate(current, latest)).toBe(diff);
  });

  it('bumps ranges keeping their operator', () => {
    expect(bumpRange('^1.2.3', '1.4.0')).toBe('^1.4.0');
    expect(bumpRange('~1.2.3', '1.2.9')).toBe('~1.2.9');
    expect(bumpRange('1.2.3', '1.2.4')).toBe('1.2.4');
    expect(bumpRange('>=1.2.3', '2.0.0')).toBe('>=2.0.0');
    expect(bumpRange('1.x', '2.1.0')).toBe('2.x');
    expect(bumpRange('*', '2.1.0')).toBe('*');
  });

  it('picks the highest stable version', () => {
    expect(highestVersion(['1.0.0', '1.2.0', '2.0.0-rc.1', '1.10.0'])).toBe('1.10.0');
    expect(highestVersion(['2.0.0-rc.1'], { allowPrerelease: true })).toBe('2.0.0-rc.1');
    expect(highestVersion(['2.0.0-rc.1'])).toBeNull();
  });
});
