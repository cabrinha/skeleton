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

  // Position from median of move-form x/y inputs
  const xVals = $('input[name="x"]').map((_, el) => parseInt($(el).val() as string, 10)).get().filter(Number.isFinite);
  const yVals = $('input[name="y"]').map((_, el) => parseInt($(el).val() as string, 10)).get().filter(Number.isFinite);
  const sortedX = [...new Set(xVals)].sort((a, b) => a - b);
  const sortedY = [...new Set(yVals)].sort((a, b) => a - b);
  const cx = sortedX[Math.floor(sortedX.length / 2)] ?? 0;
  const cy = sortedY[Math.floor(sortedY.length / 2)] ?? 0;

  // Game table — find the div with the border that wraps AP + map
  const apDiv = $('div').filter((_, el) => {
    const style = $(el).attr('style') ?? '';
    return style.includes('border') && $(el).text().includes('Action Points:');
  }).first();
  const table = apDiv.find('table').first();

  const grid = new Map<string, CellInfo>();

  table.find('td').each((_, td) => {
    const $td = $(td);
    const xInp = $td.find('input[name="x"]').first();

    let x: number, y: number, isCurrent: boolean;
    if (xInp.length) {
      x = parseInt(xInp.val() as string, 10);
      y = parseInt($td.find('input[name="y"]').first().val() as string, 10);
      isCurrent = false;
    } else {
      x = cx; y = cy; isCurrent = true;
    }

    const intersectionName = $td.find('span.intersect').first().text().trim() || null;
    const cellClass = ($td.attr('class') ?? 'unknown').split(' ')[0];

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
