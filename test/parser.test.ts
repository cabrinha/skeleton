import { describe, it, expect } from 'vitest';
import { parsePage, parsePints } from '../src/parser.js';

// Minimal move-form cell (an adjacent, walkable square at x,y).
function moveCell(x: number, y: number, inner = ''): string {
  return `<td><form><input name="x" value="${x}"><input name="y" value="${y}"></form>${inner}</td>`;
}

// A City Limits edge cell: no move form, cityblock class. These must be skipped
// by the parser or they collapse onto the current-cell key and clobber it.
function cityLimitCell(): string {
  return `<td class="cityblock">(City Limits)</td>`;
}

// Wrap a 3x3 of <td> rows in the bordered AP div the parser looks for.
function page(rows: string[], ap = '81/90', zHref = '?action=foo&z=12345'): string {
  return `<!doctype html><html><body>
    <a href="${zHref}">nav</a>
    <div style="border:1px solid black;padding:4px">
      Action Points: ${ap}
      <table>${rows.map(r => `<tr>${r}</tr>`).join('')}</table>
    </div>
  </body></html>`;
}

describe('parsePage — centre of map', () => {
  // Current cell (100,100) holds our name + a human (POST t=0|0); the east
  // neighbour holds a vampire. Exercises login/AP/z-token, position geometry,
  // human-span detection, the POST drink target, and adjacent vampire parsing.
  const currentCell = `<td>
    <b>TestVamp</b>
    <span class="human">Human</span>
    <form><input name="action" value="drink"><input name="t" value="0|0"></form>
  </td>`;
  const vampCell = moveCell(101, 100, `<a href="?action=viewvamp&viewvamp=Dracula">Dracula</a>`);
  const html = page([
    moveCell(99, 99) + moveCell(100, 99) + moveCell(101, 99),
    moveCell(99, 100) + currentCell + vampCell,
    moveCell(99, 101) + moveCell(100, 101) + moveCell(101, 101),
  ]);
  const state = parsePage(html, 'TestVamp');

  it('detects a logged-in session', () => {
    expect(state.loggedIn).toBe(true);
  });

  it('parses action points', () => {
    expect(state.ap).toBe(81);
    expect(state.maxAp).toBe(90);
  });

  it('extracts the z-token', () => {
    expect(state.zToken).toBe('12345');
  });

  it('derives position from grid geometry, not coordinate median', () => {
    expect(state.position).toEqual({ x: 100, y: 100 });
  });

  it('detects the human in the current cell as a POST drink target', () => {
    const cell = state.grid.get('100,100');
    expect(cell?.isCurrent).toBe(true);
    expect(cell?.humans).toEqual(['Human']);
    expect(cell?.drinkTargets).toHaveLength(1);
    expect(cell?.drinkTargets[0].method).toBe('post');
    expect(cell?.drinkTargets[0].params).toEqual({ action: 'drink', t: '0|0' });
  });

  it('does not count our own <b>name</b> as a phantom human', () => {
    // The current cell has exactly one <span class="human">, so only one human.
    expect(state.grid.get('100,100')?.humans).toEqual(['Human']);
  });

  it('detects a vampire in an adjacent cell, excluding self', () => {
    expect(state.grid.get('101,100')?.vampires).toEqual(['Dracula']);
  });
});

describe('parsePage — north edge (City Limits)', () => {
  // Current cell (100,1); the row above is y=0, rendered as City Limits. If those
  // edge cells are not skipped they collapse onto (100,1) and wipe the real cell —
  // the "seen but not drunk near the border" bug.
  const currentCell = `<td>
    <b>TestVamp</b>
    <span class="human">Human</span>
    <form><input name="action" value="drink"><input name="t" value="0|0"></form>
  </td>`;
  const html = page([
    cityLimitCell() + cityLimitCell() + cityLimitCell(),
    moveCell(99, 1) + currentCell + moveCell(101, 1),
    moveCell(99, 2) + moveCell(100, 2) + moveCell(101, 2),
  ]);
  const state = parsePage(html, 'TestVamp');

  it('derives the true edge position (not the adjacent row)', () => {
    expect(state.position).toEqual({ x: 100, y: 1 });
  });

  it('keeps the current cell target instead of letting City Limits clobber it', () => {
    const cell = state.grid.get('100,1');
    expect(cell?.isCurrent).toBe(true);
    expect(cell?.humans).toEqual(['Human']);
    expect(cell?.drinkTargets).toHaveLength(1);
  });
});

describe('parsePints', () => {
  it('reads pints gained from a drink response', () => {
    expect(parsePints('<br>You gain 5 pints of blood!<br>')).toBe(5);
  });

  it('ignores the cumulative "have drunk N pints" total line', () => {
    const html = '<br>You gain 3 pints!<br>You have drunk 9999 pints in total<br>';
    expect(parsePints(html)).toBe(3);
  });

  it('returns 0 when the target was already dry', () => {
    expect(parsePints('<br>You have drunk 9999 pints in total<br>')).toBe(0);
    expect(parsePints('<br>Nothing happens.<br>')).toBe(0);
  });
});
