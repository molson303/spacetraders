import 'dotenv/config';
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import { systemOf } from '../state/world.js';
import { getLatestPrice } from '../state/repos.js';

const GATE = process.env.GATE?.trim() || 'X1-A20-I56';
const SOURCES: Record<string, string> = {
  FAB_MATS: 'X1-A20-F48',
  ADVANCED_CIRCUITRY: 'X1-A20-D41',
};

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const system = systemOf(GATE);
  const agent = await api.getMyAgent();
  console.log(`credits=${agent.credits}`);
  const c = await api.getConstruction(system, GATE);
  console.log(`gate ${GATE} complete=${c.isComplete}`);
  let est = 0;
  for (const m of c.materials) {
    const remaining = Math.max(0, m.required - m.fulfilled);
    const src = SOURCES[m.tradeSymbol];
    const price = src ? (getLatestPrice(src, m.tradeSymbol)?.purchase_price ?? 0) : 0;
    const cost = remaining * price;
    est += cost;
    console.log(
      `  ${m.tradeSymbol}: ${m.fulfilled}/${m.required} (remaining ${remaining}) ` +
        `src=${src ?? 'NONE'} ~${price}/u estCost=${cost}`,
    );
  }
  console.log(`total est remaining material cost: ~${est}`);
  closeDb();
}

main().catch((e) => {
  console.error(e);
  closeDb();
  process.exit(1);
});
