import { load } from 'cheerio';

export interface Coord {
  x: number;
  y: number;
}

export interface DrinkTarget {
  name: string;
  method: 'get' | 'post';
  params: Record<string, string>;
}

export interface CellInfo {
  coord: Coord;
  isCurrent: boolean;
  cellClass: string;
  intersectionName: string | null;
  vampires: string[];
  humans: string[];
  drinkTargets: DrinkTarget[];
  hunters: string[];
}

export interface PageState {
  loggedIn: boolean;
  ap: number;
  maxAp: number;
  position: Coord;
  zToken: string | null;
  grid: Map<string, CellInfo>;
}

export function parsePage(html: string, selfName: string): PageState {
  const $ = load(html);

  const loggedIn = $('input[name="passwd"]').length === 0 && html.includes('Action Points:');

  // z token from any nav link
  let zToken: string | null = null;
  $('a[href]').each((_, el) => {
    if (zToken) return false;
    const m = ($(el).attr('href') ?? '').match(/[?&]z=(\d+)/);
    if (m) zToken = m[1];
  });

  // AP — search for text node containing "Action Points:"
  let ap = 0, maxAp = 90;
  $('*').contents().each((_, node) => {
    if (node.type !== 'text') return;
    const text = (node as unknown as { data: string }).data;
    const m = text.match(/Action Points:\s*(\d+)\/(\d+)/);
    if (m) { ap = parseInt(m[1], 10); maxAp = parseInt(m[2], 10); return false; }
  });

  // Game table — find the div with the border that wraps AP + map
  const apDiv = $('div').filter((_, el) => {
    const style = $(el).attr('style') ?? '';
    return style.includes('border') && $(el).text().includes('Action Points:');
  }).first();
  const table = apDiv.find('table').first();

  // Position from grid geometry. The map is a 3×3 table; find the cell we occupy (the
  // one with no move form that isn't City Limits) and read an orthogonal neighbour's
  // coordinate to derive our own. Median-of-visible-coordinates is WRONG at map edges,
  // where the 3×3 window is asymmetric — e.g. at the north edge the visible y-values
  // are {0,1} and the median picks the adjacent row (182,1) instead of the true hole
  // (182,0), so every move reads as "position unchanged" and the sweeper spins forever
  // reversing direction without ever spending AP.
  const formX = new Map<string, number>();
  const formY = new Map<string, number>();
  let curR = -1, curC = -1;
  table.find('tr').each((r, tr) => {
    $(tr).children('td').each((c, td) => {
      const $td = $(td);
      const xInp = $td.find('input[name="x"]').first();
      if (xInp.length) {
        formX.set(`${r},${c}`, parseInt(xInp.val() as string, 10));
        formY.set(`${r},${c}`, parseInt($td.find('input[name="y"]').first().val() as string, 10));
      } else {
        const cls = ($td.attr('class') ?? '').split(' ')[0];
        if (cls !== 'cityblock' && !/City Limits/i.test($td.text())) { curR = r; curC = c; }
      }
    });
  });
  let cx = 0, cy = 0;
  const rx = formX.get(`${curR},${curC + 1}`), lx = formX.get(`${curR},${curC - 1}`);
  const dyv = formY.get(`${curR + 1},${curC}`), uyv = formY.get(`${curR - 1},${curC}`);
  if (rx !== undefined)      { cx = rx - 1; cy = formY.get(`${curR},${curC + 1}`)!; }
  else if (lx !== undefined) { cx = lx + 1; cy = formY.get(`${curR},${curC - 1}`)!; }
  else if (dyv !== undefined) { cx = formX.get(`${curR + 1},${curC}`)!; cy = dyv - 1; }
  else if (uyv !== undefined) { cx = formX.get(`${curR - 1},${curC}`)!; cy = uyv + 1; }
  else {
    // Fallback (should never happen — the current cell always has an on-map orthogonal
    // neighbour): median of visible coordinates.
    const xs = [...new Set(formX.values())].sort((a, b) => a - b);
    const ys = [...new Set(formY.values())].sort((a, b) => a - b);
    cx = xs[Math.floor(xs.length / 2)] ?? 0;
    cy = ys[Math.floor(ys.length / 2)] ?? 0;
  }

  const grid = new Map<string, CellInfo>();

  table.find('td').each((_, td) => {
    const $td = $(td);
    const cellClass = ($td.attr('class') ?? 'unknown').split(' ')[0];
    const xInp = $td.find('input[name="x"]').first();

    let x: number, y: number, isCurrent: boolean;
    if (xInp.length) {
      x = parseInt(xInp.val() as string, 10);
      y = parseInt($td.find('input[name="y"]').first().val() as string, 10);
      isCurrent = false;
    } else {
      // No move form. This is either the cell we're standing in (holds our
      // <b>Name</b> plus any target) OR a City Limits cell at the map edge.
      // City Limits cells ALSO lack a move form, so without this guard every one
      // of them collapses onto the current-cell key (cx,cy) and the last-written
      // empty edge cell clobbers the real current cell — wiping out any human /
      // drink target on it. That is why targets got "seen but not drunk" at edges.
      if (cellClass === 'cityblock' || /City Limits/i.test($td.text())) return;
      x = cx; y = cy; isCurrent = true;
    }

    const intersectionName = $td.find('span.intersect').first().text().trim() || null;

    // Other vampires via viewvamp links (excluding self)
    const vampires: string[] = [];
    $td.find('a[href*="viewvamp"]').each((_, el) => {
      const name = $(el).text().trim();
      if (name && name !== selfName) vampires.push(name);
    });

    // Drink targets
    const drinkTargets: DrinkTarget[] = [];
    const seenDrink = new Set<string>();

    // GET links: <a href*="action=drink">
    $td.find('a[href*="action=drink"]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      const m = href.match(/target=([^&\s]+)/);
      if (!m) return;
      const name = decodeURIComponent(m[1].replace(/\+/g, ' '));
      if (!seenDrink.has(name)) {
        drinkTargets.push({ name, method: 'get', params: { target: name } });
        seenDrink.add(name);
      }
    });

    // POST forms: action=drink with t= (human) or target= (fallback)
    $td.find('form').each((_, form) => {
      const $form = $(form);
      if ($form.find('input[name="action"]').val() !== 'drink') return;
      const tInp = $form.find('input[name="t"]');
      const targetInp = $form.find('input[name="target"]');
      let name: string, params: Record<string, string>;
      if (tInp.length) {
        const tVal = tInp.val() as string;
        name = `Human(${tVal})`;
        params = { action: 'drink', t: tVal };
      } else if (targetInp.length) {
        name = targetInp.val() as string;
        params = { action: 'drink', target: name };
      } else {
        return;
      }
      if (!seenDrink.has(name)) {
        drinkTargets.push({ name, method: 'post', params });
        seenDrink.add(name);
      }
    });

    // Hunters: fight/attack/kill links
    const hunters: string[] = [];
    $td.find('a[href]').each((_, el) => {
      const href = $(el).attr('href') ?? '';
      if (!/action=(fight|attack|kill)/.test(href)) return;
      const m = href.match(/target=([^&\s]+)/);
      if (m) {
        const name = decodeURIComponent(m[1].replace(/\+/g, ' '));
        if (!hunters.includes(name)) hunters.push(name);
      }
    });

    // Humans: rendered as <span class="human">Human</span> in every cell — both
    // adjacent (no drink form) and co-located (followed by a drink form). Detect the
    // span directly; the old leftover-text scan wrongly counted our own <b>Name</b>
    // (and any bold vampire name) as a phantom human in the current cell.
    const humans: string[] = [];
    $td.find('span.human').each((_, el) => {
      const t = $(el).text().replace(/\(\d+\)/g, '').replace(/[()]/g, '').trim();
      if (t) humans.push(t);
    });

    grid.set(`${x},${y}`, { coord: { x, y }, isCurrent, cellClass, intersectionName, vampires, humans, drinkTargets, hunters });
  });

  return { loggedIn, ap, maxAp, position: { x: cx, y: cy }, zToken, grid };
}

export function parsePints(html: string): number {
  for (const line of html.split(/\n|<br\s*\/?>/i)) {
    if (/have drunk/i.test(line)) continue;
    const m = line.match(/(\d+)\s+pint/i);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}
