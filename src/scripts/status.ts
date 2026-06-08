import { SpaceTradersApi } from '../client/api.js';
import { log } from '../util/logger.js';

const api = new SpaceTradersApi();
const agent = await api.getMyAgent();
log.info(`credits=${agent.credits}`);
const ships = (await api.listShips()).data;
for (const s of ships) {
  log.info(
    `${s.symbol} ${s.nav.status} @${s.nav.waypointSymbol} fuel=${s.fuel.current}/${s.fuel.capacity} cargo=${s.cargo.units}/${s.cargo.capacity} ${JSON.stringify(s.cargo.inventory.map((i) => `${i.units} ${i.symbol}`))}`,
  );
}
const contracts = (await api.listContracts()).data;
for (const c of contracts) {
  if (c.fulfilled) continue;
  for (const d of c.terms.deliver ?? []) {
    log.info(`contract ${c.id} ${d.tradeSymbol} ${d.unitsFulfilled}/${d.unitsRequired} -> ${d.destinationSymbol} accepted=${c.accepted}`);
  }
}
