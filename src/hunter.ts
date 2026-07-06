import { Bot } from './bot.js';
import { type PageState, type CellInfo } from './parser.js';
import { metrics } from './metrics.js';
import { logEvent } from './db.js';
import { locationName } from './location.js';
import { AP_SECS_PER_TICK, MAP_SIZE, SWEEP_DELAY_MS, SINGLE_RUN } from './config.js';

export class Hunter {
  private dirX = 1;  // +1 = east, -1 = west
  private dirY = -1; // -1 = NE (y decreasing), +1 = SE (y increasing)
  private drained = new Map<string, Set<string>>(); // "x,y" → drained target names

  constructor(private readonly bot: Bot) {}

  private log(msg: string): void {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`[${t}] ${msg}`);
  }

  private drainedAt(x: number, y: number): Set<string> {
    const key = `${x},${y}`;
    if (!this.drained.has(key)) this.drained.set(key, new Set());
    return this.drained.get(key)!;
  }

  private nextSweepPos(x: number, y: number): { x: number; y: number } {
    let ny = y + this.dirY;
    if (ny < 1)        { this.dirY = 1;  ny = y + 1; }
    else if (ny > MAP_SIZE) { this.dirY = -1; ny = y - 1; }
    return { x: x + this.dirX, y: ny };
  }

  private async drinkAll(state: PageState): Promise<void> {
    const { x, y } = state.position;
    const drained = this.drainedAt(x, y);
    const cell = state.grid.get(`${x},${y}`);
    if (!cell) return;

    for (const target of cell.drinkTargets) {
      if (drained.has(target.name)) continue;
      this.log(`Drinking from '${target.name}' (${target.method}) at ${locationName(x, y)}`);
      const { state: next, pints } = await this.bot.drink(target, state.zToken);
      drained.add(target.name);
      if (pints === 0) {
        this.log(`  → already drained`);
        continue;
      }
      this.log(`  → got ${pints} pint(s)`);
      metrics.pintsTotal.inc(pints);
      metrics.humansBitten.inc();
      metrics.sessionPints.inc(pints);
      metrics.sessionHumans.inc();
      await logEvent('drink', { target: target.name, pints, pos: { x, y }, ap: next.ap });
      // update AP metrics after each drink
      metrics.ap.set(next.ap);
      metrics.apEta.set(Math.max(0, (next.maxAp - next.ap) * AP_SECS_PER_TICK));
    }
  }

  private async fightAll(state: PageState): Promise<void> {
    const cell = state.grid.get(`${state.position.x},${state.position.y}`);
    if (!cell?.hunters.length) return;
    metrics.huntersEncountered.inc(cell.hunters.length);
    for (const hunter of cell.hunters) {
      this.log(`Fighting hunter '${hunter}'`);
      const next = await this.bot.fight(hunter, state.zToken);
      const killed = next.grid.get(`${state.position.x},${state.position.y}`)?.hunters.includes(hunter) === false;
      if (killed) { metrics.huntersKilled.inc(); this.log(`  → killed`); }
    }
  }

  async waitForFullAp(): Promise<void> {
    metrics.hunting.set(0);
    while (true) {
      const state = await this.bot.fetchPage();
      const { ap, maxAp } = state;
      metrics.ap.set(ap);
      metrics.apMax.set(maxAp);
      if (ap >= maxAp) {
        metrics.apEta.set(0);
        this.log(`AP full (${ap}/${maxAp})`);
        return;
      }
      const needed = maxAp - ap;
      const waitSecs = needed * AP_SECS_PER_TICK;
      const wakeTime = new Date(Date.now() + waitSecs * 1000).toTimeString().slice(0, 5);
      this.log(`AP ${ap}/${maxAp} — sleeping ${needed * 15}m (until ~${wakeTime})`);
      metrics.apEta.set(waitSecs);
      await this.sleepUpdatingMetrics(waitSecs, ap, maxAp);
    }
  }

  private async sleepUpdatingMetrics(totalSecs: number, apStart: number, maxAp: number): Promise<void> {
    const started = Date.now();
    while (true) {
      const elapsed = (Date.now() - started) / 1000;
      if (elapsed >= totalSecs) break;
      const current = Math.min(maxAp, apStart + elapsed / AP_SECS_PER_TICK);
      metrics.ap.set(current);
      metrics.apEta.set(Math.max(0, (maxAp - current) * AP_SECS_PER_TICK));
      await sleep(Math.min(60_000, (totalSecs - elapsed) * 1000));
    }
  }

  private cellScore(cell: CellInfo): number {
    const cd = this.drainedAt(cell.coord.x, cell.coord.y);
    const h = cell.humans.filter(n => !cd.has(n)).length;
    const v = cell.vampires.filter(n => !cd.has(n)).length;
    // Humans weighted heavier — clusters of them are the main food source
    return h * 10 + v * 3;
  }

  private logGrid(state: PageState): void {
    const rows: string[] = [];
    for (const cell of state.grid.values()) {
      const h = cell.humans.length, v = cell.vampires.length;
      if (!h && !v) continue;
      const cd = this.drainedAt(cell.coord.x, cell.coord.y);
      const avH = cell.humans.filter(n => !cd.has(n)).length;
      const avV = cell.vampires.filter(n => !cd.has(n)).length;
      const here = cell.isCurrent ? '*' : ' ';
      rows.push(`  ${here} ${locationName(cell.coord.x, cell.coord.y)}  ${v}v/${h}h  (${avV}v/${avH}h available)`);
    }
    if (rows.length) this.log('Visible:\n' + rows.join('\n'));
  }

  private findBestAdjacentTarget(state: PageState, x: number, y: number): CellInfo | null {
    let best: CellInfo | null = null;
    let bestScore = 0;
    let bestIsDiagonal = false;

    for (const cell of state.grid.values()) {
      if (cell.isCurrent) continue;
      const score = this.cellScore(cell);
      if (score === 0) continue;
      const isDiagonal = cell.coord.x !== x && cell.coord.y !== y;
      if (score > bestScore || (score === bestScore && isDiagonal && !bestIsDiagonal)) {
        best = cell;
        bestScore = score;
        bestIsDiagonal = isDiagonal;
      }
    }
    return best;
  }

  async tick(state: PageState): Promise<void> {
    const { x, y } = state.position;
    const drained = this.drainedAt(x, y);
    const current = state.grid.get(`${x},${y}`);

    // 1. Drink available targets in current cell
    const available = current?.drinkTargets.filter(t => !drained.has(t.name)) ?? [];
    if (available.length) {
      await this.drinkAll(state);
      return;
    }

    // 2. Fight hunters
    await this.fightAll(state);

    // 3. Move directly toward highest-scoring adjacent cell (most humans, then vampires)
    this.logGrid(state);
    const target = this.findBestAdjacentTarget(state, x, y);
    if (target) {
      const cd = this.drainedAt(target.coord.x, target.coord.y);
      const avH = target.humans.filter(n => !cd.has(n)).length;
      const avV = target.vampires.filter(n => !cd.has(n)).length;
      const tx = target.coord.x, ty = target.coord.y;
      this.log(`Best target ${locationName(tx, ty)} [${avH}h/${avV}v] — moving there`);
      const next = await this.bot.move(tx, ty);
      metrics.movesTotal.inc();
      if (next.position.x !== x || next.position.y !== y) {
        metrics.posX.set(next.position.x);
        metrics.posY.set(next.position.y);
        metrics.ap.set(next.ap);
        metrics.apEta.set(Math.max(0, (next.maxAp - next.ap) * AP_SECS_PER_TICK));
        this.logGrid(next);
        await this.drinkAll(next);
      }
      return;
    }

    // 4. Sweep diagonally NE/SE/NW/SW
    const { x: nx, y: ny } = this.nextSweepPos(x, y);
    this.log(`Sweeping → ${locationName(nx, ny)}  AP=${state.ap}`);
    const next = await this.bot.move(nx, ny);
    metrics.movesTotal.inc();

    if (next.position.x === x && next.position.y === y) {
      // Move rejected by server (City Limits) — reverse x direction
      this.log(`Hit city edge at ${locationName(x, y)} — reversing direction`);
      this.dirX *= -1;
    } else {
      metrics.posX.set(next.position.x);
      metrics.posY.set(next.position.y);
      metrics.ap.set(next.ap);
      metrics.apEta.set(Math.max(0, (next.maxAp - next.ap) * AP_SECS_PER_TICK));
      this.logGrid(next);
      await this.drinkAll(next);
    }
  }

  async run(waitForFull: boolean): Promise<void> {
    if (waitForFull) await this.waitForFullAp();

    metrics.sessionPints.set(0);
    metrics.sessionHumans.set(0);
    metrics.hunting.set(1);
    this.log('Hunt started');

    while (true) {
      const state = await this.bot.fetchPage();

      if (!state.loggedIn) {
        this.log('Session expired — re-authenticating');
        if (!await this.bot.login()) { this.log('Re-login failed, stopping'); return; }
        continue;
      }

      const { ap, maxAp, position: { x, y } } = state;
      metrics.ap.set(ap);
      metrics.apMax.set(maxAp);
      metrics.posX.set(x);
      metrics.posY.set(y);

      this.log(`AP=${ap}/${maxAp}  at ${locationName(x, y)}`);

      if (ap <= 0) {
        metrics.hunting.set(0);
        if (SINGLE_RUN) { this.log('AP exhausted — done (single-run mode)'); return; }
        const waitSecs = maxAp * AP_SECS_PER_TICK;
        const wake = new Date(Date.now() + waitSecs * 1000).toTimeString().slice(0, 5);
        this.log(`AP exhausted — sleeping until full (~${wake})`);
        await this.sleepUpdatingMetrics(waitSecs, 0, maxAp);
        metrics.hunting.set(1);
        metrics.sessionPints.set(0);
        metrics.sessionHumans.set(0);
        continue;
      }

      await this.tick(state);
      await sleep(SWEEP_DELAY_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
