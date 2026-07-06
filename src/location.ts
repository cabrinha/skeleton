import { MAP_SIZE } from './config.js';

// The 100 named north–south streets, west → east. Odd x coordinates (1,3,…,199)
// sit ON a named street; index = (x-1)/2. Even x sits on the block between two.
// Verified against live game intersection labels: x=199 → "Zestless", y=3 → "2nd".
// (Note: this is the game's real 1-based-odd layout, which is off-by-one from
// city-crawler's border-offset formula — trust the live HTML, not that.)
export const STREET_NAMES: string[] = [
  'Aardvark', 'Alder', 'Buzzard', 'Beech', 'Cormorant', 'Cedar', 'Duck', 'Dogwood', 'Eagle', 'Elm',
  'Ferret', 'Fir', 'Gibbon', 'Gum', 'Haddock', 'Holly', 'Iguana', 'Ivy', 'Jackal', 'Juniper',
  'Kraken', 'Knotweed', 'Lion', 'Larch', 'Mongoose', 'Maple', 'Nightingale', 'Nettle', 'Octopus', 'Olive',
  'Pilchard', 'Pine', 'Quail', 'Quince', 'Raven', 'Ragweed', 'Squid', 'Sycamore', 'Tapir', 'Teasel',
  'Unicorn', 'Umbrella', 'Vulture', 'Vervain', 'Walrus', 'Willow', 'Yak', 'Yew', 'Zebra', 'Zelkova',
  'Amethyst', 'Anguish', 'Beryl', 'Bleak', 'Cobalt', 'Chagrin', 'Diamond', 'Despair', 'Emerald', 'Ennui',
  'Flint', 'Fear', 'Gypsum', 'Gloom', 'Hessite', 'Horror', 'Ivory', 'Ire', 'Jet', 'Jaded',
  'Kyanite', 'Killjoy', 'Lead', 'Lonely', 'Malachite', 'Malaise', 'Nickel', 'Nervous', 'Obsidian', 'Oppression',
  'Pyrites', 'Pessimism', 'Quartz', 'Qualms', 'Ruby', 'Regret', 'Steel', 'Sorrow', 'Turquoise', 'Torment',
  'Uranium', 'Unctuous', 'Vauxite', 'Vexation', 'Wulfenite', 'Woe', 'Yuksporite', 'Yearning', 'Zinc', 'Zestless',
];

function ordinal(n: number): string {
  const t = n % 100, d = n % 10;
  const suffix = t >= 11 && t <= 13 ? 'th' : d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

// Named street (or the block spanning two) for an x coordinate.
function namedAt(x: number): string {
  if (x < 1) return 'West Limits';
  if (x > MAP_SIZE) return 'East Limits';
  if (x % 2 === 1) return STREET_NAMES[(x - 1) / 2] ?? `x${x}`;
  const a = STREET_NAMES[(x - 2) / 2], b = STREET_NAMES[x / 2];
  return a && b ? `${a}–${b}` : (a ?? b ?? `x${x}`);
}

// Numbered street (or the block spanning two) for a y coordinate.
function numberedAt(y: number): string {
  if (y < 1) return 'North Limits';
  if (y > MAP_SIZE) return 'South Limits';
  if (y % 2 === 1) return ordinal((y + 1) / 2);
  return `${ordinal(y / 2)}–${ordinal(y / 2 + 1)}`;
}

/**
 * Human-readable street location for a grid coordinate.
 * Intersections (both odd) read as "Zestless & 2nd"; anything else as
 * "Zestless @ 2nd–3rd" (on a street/block between intersections).
 * The raw (x,y) is appended for debugging movement and City Limits.
 */
export function locationName(x: number, y: number): string {
  const named = namedAt(x), num = numberedAt(y);
  const label = x % 2 === 1 && y % 2 === 1 ? `${named} & ${num}` : `${named} @ ${num}`;
  return `${label} (${x},${y})`;
}
