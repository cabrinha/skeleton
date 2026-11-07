import { startMetricsServer, stopMetricsServer } from './metrics.js';
import { initDb, closeDb } from './db.js';
import { Session } from './session.js';
import { createBot } from './bot.js';
import { Hunter } from './hunter.js';
import { WAIT_FOR_FULL_AP } from './config.js';

async function releaseResources(): Promise<void> {
  // Close the listening socket and the pg pool so Node's event loop can drain.
  await Promise.allSettled([stopMetricsServer(), closeDb()]);
}

async function main() {
  startMetricsServer();
  await initDb();

  // Graceful shutdown: K8s sends SIGTERM on pod termination (and Ctrl-C sends
  // SIGINT locally). Release the socket + pool and exit cleanly instead of being
  // SIGKILLed after the grace period.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[${signal}] shutting down`);
    await releaseResources();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const session = new Session();
  const bot = createBot(session);

  if (!(await bot.login())) {
    await releaseResources();
    process.exit(1);
  }

  const state = await bot.fetchPage();
  console.log(`Position : (${state.position.x}, ${state.position.y})`);
  console.log(`AP       : ${state.ap}/${state.maxAp}`);

  const hunter = new Hunter(bot);
  await hunter.run(WAIT_FOR_FULL_AP);

  // In single-run mode hunter.run() returns once AP is exhausted. The metrics
  // HTTP server (listening socket) and the pg pool keep Node's event loop alive,
  // so without an explicit exit the process lingers idle: the Job never completes
  // and concurrencyPolicy: Forbid blocks the next scheduled hunt until the pod
  // hits activeDeadlineSeconds (~25h). Release resources and exit so the CronJob
  // can cycle. (In continuous mode run() never returns, so this is unreachable.)
  await releaseResources();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
