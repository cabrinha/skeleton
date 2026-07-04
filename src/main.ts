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
}

main().catch(err => { console.error(err); process.exit(1); });
