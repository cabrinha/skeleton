import { startMetricsServer } from './metrics.js';
import { initDb } from './db.js';
import { Session } from './session.js';
import { createBot } from './bot.js';
import { Hunter } from './hunter.js';
import { WAIT_FOR_FULL_AP } from './config.js';

async function main() {
  startMetricsServer();
  await initDb();

  const session = new Session();
  const bot = createBot(session);

  if (!await bot.login()) process.exit(1);

  const state = await bot.fetchPage();
  console.log(`Position : (${state.position.x}, ${state.position.y})`);
  console.log(`AP       : ${state.ap}/${state.maxAp}`);

  const hunter = new Hunter(bot);
  await hunter.run(WAIT_FOR_FULL_AP);

  // In single-run mode hunter.run() returns once AP is exhausted. The metrics
  // HTTP server (listening socket) and the pg pool keep Node's event loop alive,
  // so without an explicit exit the process lingers idle: the Job never completes
  // and concurrencyPolicy: Forbid blocks the next scheduled hunt until the pod
  // hits activeDeadlineSeconds (~25h). Exit cleanly so the CronJob can cycle.
  // (In continuous mode run() never returns, so this line is unreachable.)
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
