import 'dotenv/config';
import { closeDb } from '../state/db.js';
import { getLatestPricesForGood } from '../state/repos.js';

const system = process.env.HOME_SYSTEM ?? 'X1-A20';
for (const good of ['FAB_MATS', 'ADVANCED_CIRCUITRY']) {
  console.log(`\n=== ${good} markets in ${system} ===`);
  const rows = getLatestPricesForGood(system, good);
  for (const r of rows) {
    console.log(
      `  ${r.waypoint} type=${(r as any).type ?? '?'} buy(purchase)=${(r as any).purchase_price} sell=${(r as any).sell_price} vol=${(r as any).trade_volume} supply=${(r as any).supply}`,
    );
  }
}
closeDb();
