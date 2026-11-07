import { describe, it, expect } from 'vitest';
import { locationName } from '../src/location.js';

describe('locationName', () => {
  it('names an intersection (both coordinates odd)', () => {
    // Verified against the live game: x=199 → Zestless, y=3 → 2nd.
    expect(locationName(199, 3)).toBe('Zestless & 2nd (199,3)');
    expect(locationName(1, 1)).toBe('Aardvark & 1st (1,1)');
  });

  it('names a block between two streets (even x)', () => {
    expect(locationName(2, 1)).toBe('Aardvark–Alder @ 1st (2,1)');
  });

  it('names a block between two numbered streets (even y)', () => {
    expect(locationName(1, 2)).toBe('Aardvark @ 1st–2nd (1,2)');
  });

  it('labels coordinates beyond the map as City Limits', () => {
    expect(locationName(0, 1)).toContain('West Limits');
    expect(locationName(201, 1)).toContain('East Limits');
    expect(locationName(1, 0)).toContain('North Limits');
    expect(locationName(1, 201)).toContain('South Limits');
  });

  it('uses correct ordinal suffixes (11th–13th are special)', () => {
    // y=21 → (21+1)/2 = 11th, y=23 → 12th, y=25 → 13th.
    expect(locationName(1, 21)).toBe('Aardvark & 11th (1,21)');
    expect(locationName(1, 25)).toBe('Aardvark & 13th (1,25)');
  });
});
