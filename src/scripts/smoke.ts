/* Live smoke test: verify token + client against the real API (read-only). */
import { SpaceTradersApi } from '../client/api.js';
import { log } from '../util/logger.js';

async function main(): Promise<void> {
  const api = new SpaceTradersApi();

  const agent = await api.getMyAgent();
  log.info(`agent ${agent.symbol} | credits=${agent.credits} | hq=${agent.headquarters} | ships=${agent.shipCount}`);

  const ships = await api.listShips();
  for (const s of ships.data) {
    log.info(
      `ship ${s.symbol} role=${s.registration.role} frame=${s.frame.symbol} @${s.nav.waypointSymbol} ${s.nav.status} cargo=${s.cargo.units}/${s.cargo.capacity} fuel=${s.fuel.current}/${s.fuel.capacity}`,
    );
  }

  const contracts = await api.listContracts();
  for (const c of contracts.data) {
    const deliver = c.terms.deliver?.map((d) => `${d.unitsFulfilled}/${d.unitsRequired} ${d.tradeSymbol}->${d.destinationSymbol}`).join('; ');
    log.info(
      `contract ${c.id} ${c.type} accepted=${c.accepted} fulfilled=${c.fulfilled} pay=${c.terms.payment.onAccepted}+${c.terms.payment.onFulfilled} deliver=[${deliver}]`,
    );
  }

  log.info('live smoke test complete');
}

main().catch((err) => {
  log.error('smoke test failed', err);
  process.exitCode = 1;
});
