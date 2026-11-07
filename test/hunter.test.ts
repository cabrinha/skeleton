import { describe, it, expect } from 'vitest';
import { Hunter, HUMANS_DRAINED } from '../src/hunter.js';
import type { Bot } from '../src/bot.js';
import type { CellInfo, DrinkTarget } from '../src/parser.js';

// The sweep/scoring logic lives in private methods; reach them through a typed cast.
type HunterInternals = {
  nextSweepPos(x: number, y: number): { x: number; y: number };
  isDrained(drained: Set<string>, t: DrinkTarget): boolean;
  cellScore(cell: CellInfo): number;
  drainedAt(x: number, y: number): Set<string>;
};

function newHunter(): Hunter & HunterInternals {
  // The methods under test never touch the bot, so a stub is fine.
  return new Hunter(undefined as unknown as Bot) as unknown as Hunter & HunterInternals;
}

function cell(x: number, y: number, humans: string[], vampires: string[]): CellInfo {
  return {
    coord: { x, y },
    isCurrent: false,
    cellClass: 'street',
    intersectionName: null,
    vampires,
    humans,
    drinkTargets: [],
    hunters: [],
  };
}

describe('nextSweepPos', () => {
  it('steps NE by default (east, y decreasing)', () => {
    expect(newHunter().nextSweepPos(100, 100)).toEqual({ x: 101, y: 99 });
  });

  it('bounces off the north boundary (y=1) and flips to SE', () => {
    const h = newHunter();
    expect(h.nextSweepPos(100, 1)).toEqual({ x: 101, y: 2 });
    // Direction now sticks going south.
    expect(h.nextSweepPos(101, 2)).toEqual({ x: 102, y: 3 });
  });

  it('bounces off the south boundary (y=200) and flips to NE', () => {
    const h = newHunter();
    expect(h.nextSweepPos(50, 200)).toEqual({ x: 51, y: 199 });
  });
});

describe('isDrained', () => {
  const getTarget: DrinkTarget = { name: 'Dracula', method: 'get', params: { target: 'Dracula' } };
  const postTarget: DrinkTarget = {
    name: 'Human(0|0)',
    method: 'post',
    params: { action: 'drink', t: '0|0' },
  };

  it('gates vampires by unique name', () => {
    const h = newHunter();
    const drained = new Set<string>();
    expect(h.isDrained(drained, getTarget)).toBe(false);
    drained.add('Dracula');
    expect(h.isDrained(drained, getTarget)).toBe(true);
  });

  it('gates humans by the per-cell sentinel, not by name', () => {
    const h = newHunter();
    const drained = new Set<string>();
    expect(h.isDrained(drained, postTarget)).toBe(false);
    drained.add(HUMANS_DRAINED);
    expect(h.isDrained(drained, postTarget)).toBe(true);
  });
});

describe('cellScore', () => {
  it('weights humans over vampires', () => {
    // 2 humans * 10 + 1 vampire * 3 = 23.
    expect(newHunter().cellScore(cell(10, 10, ['Human', 'Human'], ['V1']))).toBe(23);
  });

  it('drops drained targets to zero so the bot stops oscillating back onto them', () => {
    const h = newHunter();
    const drained = h.drainedAt(10, 10);
    drained.add(HUMANS_DRAINED); // all humans here are dry
    drained.add('V1'); // this vampire is dry
    expect(h.cellScore(cell(10, 10, ['Human', 'Human'], ['V1']))).toBe(0);
  });
});
