import { SpaceTradersApi } from '../client/api.js';
import { findWaypointsByTrait } from '../state/repos.js';
import { systemOf } from '../state/world.js';
import { log } from '../util/logger.js';

const api = new SpaceTradersApi();
const agent = await api.getMyAgent();
const system = systemOf(agent.headquarters);
log.info(`credits=${agent.credits} system=${system}`);

const yards = findWaypointsByTrait(system, 'SHIPYARD');
for (const wp of yards) {
  try {
    const y = await api.getShipyard(system, wp.symbol);
    log.info(`SHIPYARD ${wp.symbol} (${wp.x},${wp.y}) types=${JSON.stringify(y.shipTypes?.map((t) => t.type))}`);
    for (const s of y.ships ?? []) {
      log.info(`   ${s.type} "${s.name}" price=${s.purchasePrice} frame=${s.frame?.symbol} engine=${s.engine?.symbol} supply=${s.supply ?? '?'}`);
    }
  } catch (err) {
    log.warn(`${wp.symbol}: ${(err as Error).message}`);
  }
}
