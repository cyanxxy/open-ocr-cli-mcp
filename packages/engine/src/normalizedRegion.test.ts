import { describe, expect, it } from 'vitest';

import { assertNormalizedRegion, isNormalizedRegion } from './normalizedRegion';

function region(overrides: Record<string, unknown> = {}): unknown {
  return { page: 1, x: 0.1, y: 0.2, width: 0.3, height: 0.4, units: 'normalized', ...overrides };
}

describe('normalizedRegion', () => {
  it('accepts a well-formed region', () => {
    expect(isNormalizedRegion(region())).toBe(true);
    expect(assertNormalizedRegion(region())).toEqual(region());
  });

  it('rejects non-object values', () => {
    for (const value of [null, undefined, 'region', 42, [region()]]) {
      expect(isNormalizedRegion(value)).toBe(false);
    }
  });

  it('requires units to be "normalized"', () => {
    expect(isNormalizedRegion(region({ units: 'pixels' }))).toBe(false);
  });

  it('requires a 1-based integer page', () => {
    expect(isNormalizedRegion(region({ page: 0 }))).toBe(false);
    expect(isNormalizedRegion(region({ page: 1.5 }))).toBe(false);
  });

  it('rejects non-numeric and NaN coordinates', () => {
    expect(isNormalizedRegion(region({ width: '0.3' }))).toBe(false);
    expect(isNormalizedRegion(region({ height: Number.NaN }))).toBe(false);
  });

  it('rejects out-of-range origins and non-positive extents', () => {
    expect(isNormalizedRegion(region({ x: -0.1 }))).toBe(false);
    expect(isNormalizedRegion(region({ x: 1 }))).toBe(false);
    expect(isNormalizedRegion(region({ width: 0 }))).toBe(false);
  });

  // The case the deleted regionRaster suite covered: each edge is in range on
  // its own, but the region runs off the page once the extent is added.
  it('rejects a region that overflows the page', () => {
    expect(() => assertNormalizedRegion(region({ x: 0.9, y: 0.2, width: 0.2, height: 0.2 })))
      .toThrow('"region" must be a normalized region object');
    expect(isNormalizedRegion(region({ y: 0.9, height: 0.2 }))).toBe(false);
  });

  it('returns a copy without keys outside the region contract', () => {
    const input = region({ label: 'top right', rotation: 0 });
    const result = assertNormalizedRegion(input);
    expect(result).toStrictEqual(region());
    expect(result).not.toBe(input);
  });

  it('names the offending field in the thrown message', () => {
    expect(() => assertNormalizedRegion(null, 'location')).toThrow('"location" must be a normalized region object');
  });
});
