import 'dotenv/config';
import { findArbitrageRoutes } from '../state/repos.js';
import { countDistinctRoutes } from '../util/routes.js';

const minProfit = Number(process.env.MIN_PROFIT ?? 20);
const system = process.env.HOME_SYSTEM ?? 'X1-A20';
const routes = findArbitrageRoutes(system, minProfit, 30);
const distinct = countDistinctRoutes(routes);
console.log(`distinct profitable routes (system=${system} minProfit=${minProfit}): ${distinct}`);
console.log(`total candidate rows: ${routes.length}`);

const goods = new Set<string>();
const sells = new Set<string>();
const picked: string[] = [];
for (const r of routes) {
  if (goods.has(r.good) || sells.has(r.sellAt)) continue;
  goods.add(r.good);
  sells.add(r.sellAt);
  picked.push(`${r.good} ${r.buyAt}->${r.sellAt} ${r.profitPerUnit}/u`);
}
console.log('distinct picks:');
picked.forEach((p) => console.log('  ' + p));
