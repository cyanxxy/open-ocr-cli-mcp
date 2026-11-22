import type { NormalizedRegion } from './agentTypes';

export function isNormalizedRegion(value: unknown): value is NormalizedRegion {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const region = value as Partial<NormalizedRegion>;
  const numericKeys: Array<keyof Pick<NormalizedRegion, 'page' | 'x' | 'y' | 'width' | 'height'>> = [
    'page',
    'x',
    'y',
    'width',
    'height',
  ];

  if (region.units !== 'normalized') return false;
  if (!Number.isInteger(region.page) || (region.page ?? 0) < 1) return false;
  if (numericKeys.some((key) => typeof region[key] !== 'number' || Number.isNaN(region[key]))) return false;
  if ((region.x ?? 0) < 0 || (region.y ?? 0) < 0 || (region.width ?? 0) <= 0 || (region.height ?? 0) <= 0) return false;
  if ((region.x ?? 0) >= 1 || (region.y ?? 0) >= 1) return false;
  if ((region.x ?? 0) + (region.width ?? 0) > 1 || (region.y ?? 0) + (region.height ?? 0) > 1) return false;

  return true;
}

/**
 * Validate a region and return a fresh copy with only the six region keys, so
 * extra keys a model adds ("label", "rotation") never reach stored results.
 */
export function assertNormalizedRegion(value: unknown, fieldName = 'region'): NormalizedRegion {
  if (!isNormalizedRegion(value)) {
    throw new TypeError(
      `"${fieldName}" must be a normalized region object with page, x, y, width, height, and units: "normalized".`,
    );
  }

  return {
    page: value.page,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
    units: 'normalized',
  };
}
