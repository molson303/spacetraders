import { SpaceTradersApi } from '../client/api.js';
import { purchaseShipAt } from '../behaviors/fleet.js';
import { closeDb } from '../state/db.js';
import { log } from '../util/logger.js';
import type { ShipType } from '../types/index.js';

const shipType = (process.env.SHIP_TYPE ?? 'SHIP_LIGHT_SHUTTLE') as ShipType;
const shipyard = process.env.SHIPYARD ?? 'X1-A20-A2';
const maxPrice = Number(process.env.MAX_PRICE ?? 120000);

const api = new SpaceTradersApi();
const ships = (await api.listShips()).data;
const scout = ships.find((s) => s.nav.waypointSymbol === shipyard) ?? ships.find((s) => s.fuel.capacity === 0);

const res = await purchaseShipAt(api, shipType, shipyard, { scout, maxPrice });
if (res.ship) log.info(`bought ${res.ship.symbol} (${shipType}); credits=${res.credits}`);
else log.warn(`no ship purchased; credits=${res.credits}`);
closeDb();
