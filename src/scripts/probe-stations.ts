import 'dotenv/config';
import { SpaceTradersApi } from '../client/api.js';
import { closeDb } from '../state/db.js';
import { systemOf } from '../state/world.js';
import { countTransactionsByWaypoint } from '../state/repos.js';
import { kvGet } from '../state/kv.js';
import { gatherStationMarkets } from '../fleet/maintenance.js';
import { planProbeStations, STRATEGIC_PRIORITY, type StationAssignment } from '../util/stations.js';

/*
 * Read-only audit of probe station coverage. Shows every eligible market ranked
 * by stationing priority (strategic pins + recent trade volume), the current
 * persisted assignments, and the plan the next maintenance cycle WOULD apply
 * (dry-run — this never writes the KV). Use it to confirm reprioritization
 * before/after a fleet restart.
 *
 * Env: STRATEGIC_MARKETS (csv), STATION_TX_WINDOW_DAYS (default 7).
 */

const strategic = new Set(
  (process.env.STRATEGIC_MARKETS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);
const windowDays = Number(process.env.STATION_TX_WINDOW_DAYS ?? 7);

async function main(): Promise<void> {
  const api = new SpaceTradersApi();
  const agent = await api.getMyAgent();
  const system = systemOf(agent.headquarters);

  const txCounts = countTransactionsByWaypoint(system, windowDays);
  const markets = gatherStationMarkets(system, { txCounts, strategic });

  const fleet = (await api.listShips()).data;
  const probes = fleet.filter((s) => s.fuel.capacity === 0);
  const posOf = new Map(probes.map((p) => [p.symbol, p.nav.waypointSymbol]));

  const existing = kvGet<StationAssignment[]>('probe_stations') ?? [];
  const plan = planProbeStations(
    markets,
    probes.map((p) => ({ symbol: p.symbol })),
    existing,
  );
  const plannedWaypoints = new Set(plan.map((a) => a.waypoint));

  console.log(`system=${system} markets=${markets.length} probes=${probes.length} window=${windowDays}d`);
  console.log(`strategic pins: ${[...strategic].join(', ') || '(none)'} (gate auto-pinned while under construction)`);

  console.log(`\n=== MARKETS by priority (✓=covered by plan) ===`);
  const ranked = [...markets].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.symbol.localeCompare(b.symbol));
  ranked.forEach((m, i) => {
    const pri = m.priority ?? 0;
    const label = pri >= STRATEGIC_PRIORITY ? 'STRATEGIC' : `tx=${txCounts.get(m.symbol) ?? 0}`;
    const covered = plannedWaypoints.has(m.symbol) ? '✓' : ' ';
    console.log(`  ${covered} #${String(i + 1).padStart(2)} ${m.symbol}  pri=${pri} (${label})`);
  });

  console.log(`\n=== PLAN vs CURRENT (moves the next cycle would make) ===`);
  let moves = 0;
  for (const a of plan.sort((x, y) => x.ship.localeCompare(y.ship))) {
    const now = posOf.get(a.ship) ?? '?';
    const move = now !== a.waypoint;
    if (move) moves++;
    console.log(`  ${a.ship}: ${now}${move ? `  ->  ${a.waypoint}  *MOVE*` : '  (stays)'}`);
  }
  console.log(`\n${moves} probe(s) would relocate.`);
  closeDb();
}

main().catch((e) => {
  console.error(e);
  closeDb();
  process.exit(1);
});
