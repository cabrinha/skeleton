import { createServer } from 'http';
import { Registry, Counter, Gauge } from 'prom-client';
import { METRICS_PORT } from './config.js';

const registry = new Registry();

export const metrics = {
  pintsTotal:          new Counter({ name: 'skeleton_pints_total',                help: 'Pints consumed',             registers: [registry] }),
  humansBitten:        new Counter({ name: 'skeleton_humans_bitten_total',        help: 'Humans bitten',              registers: [registry] }),
  huntersEncountered:  new Counter({ name: 'skeleton_hunters_encountered_total',  help: 'Hunters encountered',        registers: [registry] }),
  huntersKilled:       new Counter({ name: 'skeleton_hunters_killed_total',       help: 'Hunters killed',             registers: [registry] }),
  movesTotal:          new Counter({ name: 'skeleton_moves_total',                help: 'Map moves made',             registers: [registry] }),
  posX:                new Gauge({   name: 'skeleton_position_x',                 help: 'Current X coordinate',       registers: [registry] }),
  posY:                new Gauge({   name: 'skeleton_position_y',                 help: 'Current Y coordinate',       registers: [registry] }),
  ap:                  new Gauge({   name: 'skeleton_ap_current',                 help: 'Current AP',                 registers: [registry] }),
  apMax:               new Gauge({   name: 'skeleton_ap_max',                     help: 'Max AP',                     registers: [registry] }),
  apEta:               new Gauge({   name: 'skeleton_ap_seconds_until_full',      help: 'Seconds until AP full',      registers: [registry] }),
  hunting:             new Gauge({   name: 'skeleton_hunt_active',                help: '1 while hunting',            registers: [registry] }),
  sessionPints:        new Gauge({   name: 'skeleton_session_pints',              help: 'Pints this session',         registers: [registry] }),
  sessionHumans:       new Gauge({   name: 'skeleton_session_humans_bitten',      help: 'Humans bitten this session', registers: [registry] }),
};

export function startMetricsServer(): void {
  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(METRICS_PORT, () => console.log(`[metrics] Listening on :${METRICS_PORT}`));
}
