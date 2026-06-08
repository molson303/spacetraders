import { SpaceTradersApi } from '../client/api.js';
import { navigateTo } from '../util/nav.js';
import { systemOf } from '../state/world.js';
import { log } from '../util/logger.js';

const api = new SpaceTradersApi();
const agent = await api.getMyAgent();
const system = systemOf(agent.headquarters);
const target = process.env.SCOUT_TO ?? 'X1-A20-A2';

const ships = (await api.listShips()).data;
let probe = ships.find((s) => s.registration.role === 'SATELLITE') ?? ships.find((s) => s.fuel.capacity === 0);
if (!probe) throw new Error('no probe/satellite found');
log.info(`scouting ${probe.symbol} @${probe.nav.waypointSymbol} -> ${target}`);

probe = await navigateTo(api, probe, target);
const y = await api.getShipyard(system, target);
log.info(`SHIPYARD ${target}`);
for (const s of y.ships ?? []) {
  log.info(`   ${s.type} "${s.name}" price=${s.purchasePrice} frame=${s.frame?.symbol} engine=${s.engine?.symbol} supply=${s.supply ?? '?'}`);
}
