# SpaceTraders Fleet — Session Handoff

> Drop this file into the next session to resume exactly where we left off.
> It captures the project goal, the operating contract, the full architecture,
> everything built so far, the live runtime state, and the next steps.

Last updated: 2026-06-12, after commit `bba6c0a` (remote in-system traders rolled out live).

---

## 0. Initializing prompt (reconstructed)

> Use this verbatim to re-establish the working agreement at the start of a new session.

```
You are helping me run an aggressive, multi-ship SpaceTraders bot whose single
goal is to maximize credits. The codebase is TypeScript/Node, run via `tsx`,
with SQLite persistence through the built-in `node:sqlite`. My API token lives
in `.env` as SPACETRADERS_TOKEN (gitignored) — never print it.

Operating contract:
- Build all new behavior as pure, unit-tested helpers using dependency
  injection (no I/O in the testable core; inject every side effect).
- Before any commit: `tsc --noEmit` must exit 0 AND the full test suite must be
  green. Use conventional commits to `master`. Only push when I explicitly ask.
- STOP and report immediately if a test fails OR if live credits regress.
- Post-gate market ranking: home-system markets always rank above remote ones;
  rank neighbor/remote markets by their own trade volume.
- Prefer the modern CLI tools (rg over grep, fd over find).

The fleet runs continuously (round-free): one perpetual agent per ship, a shared
claim registry so two ships never work the same good/sell at once, plus
background maintenance timers (reinvest, probe provisioning, stats). Help me
extend it, keep it earning, and don't disrupt in-flight cargo without reason.
```

---

## 1. Goal

Maximize credits with an aggressive multi-ship bot. Home jump gate **X1-A20-I56**
construction gate (I56) is COMPLETE. Cross-system arbitrage is LIVE. We are now
scaling profit by trading *inside* remote systems (not just hauling home) and
expanding probe coverage to neighbor systems (CN42 / CY96 / GK27 / AM47).

---

## 2. Operating contract / preferences

- **Stack:** TypeScript/Node, run with `tsx`. DB: SQLite via built-in `node:sqlite`.
- **Token:** `.env` `SPACETRADERS_TOKEN` (gitignored). NEVER print it.
  - Safe read pattern: `set +x; TOK=$(grep SPACETRADERS_TOKEN .env | cut -d= -f2- | tr -d '"'"'"' ')`.
  - Keep token reads separate from log greps (combined heredoc gets blocked).
- **Tests/typecheck before commit:** `tsc --noEmit` EXIT 0 + full suite green.
- **Commits:** conventional commits to `master`. **Push only when asked.**
- **Stop/report if:** a test fails OR live credits regress.
- **Market ranking (post-gate):** home markets always rank above remote; rank
  neighbor markets by their own trade volume.
- **New work:** pure, unit-tested helpers via DI.

---

## 3. Architecture (continuous fleet model)

`src/fleet.ts` is the live entrypoint (NOT the older round-based `supervisor.ts`).

- **One perpetual agent per ship** (`runShipAgent`, `src/agents/shipAgent.ts`).
  Each iteration: claim a route from its source → run the trip → release claim →
  loop. No round barrier; a long leg never stalls siblings.
- **Roles** (`ShipRole`): `local`, `cross`, `contractor`, **`remote`** (new).
  - `local` — in-system arbitrage in the HOME system (cr/s-ranked).
  - `cross` — cross-gate arbitrage, net-profit ranked; falls back to local when
    the gate is shut or every cross lane is claimed.
  - `contractor` — runs the contract pipeline; falls back to local between contracts.
  - `remote` — **NEW**: relocates once to a remote system, then runs the same
    in-system arbitrage engine THERE (no jump back home per trade). Same control
    flow as `local`; tracked separately for stats.
- **Coordination:** single shared `ClaimRegistry` — two ships never share a good
  or a sell waypoint at once. Pick→`registry.set` is synchronous (no await
  between) to stay race-free.
- **Probes** (fuel.capacity === 0): not earners. Driven by `runProbeAgent`
  (station-keep + local scan, reserves flex[0]) and `runScoutAgent` (decoupled
  ~50-min neighbor-discovery loop, rides gates into unscanned systems).
- **Maintenance timers** (`every()` + `nonReentrant`): reinvest, probe
  provisioning, stats snapshot. First reinvest/provision/scout tick fires AFTER
  10 min.
- **Wallet mirror** (`src/state/wallet.ts`): every buy/sell updates it; the
  per-trade spend cap is resolved live as `maxTradeFraction` of the wallet.

### Route sources
- `findArbitrageRoutes(system, minProfit, limit)` (`src/state/repos.ts:528`) —
  buy/sell pairs WITHIN one system. System-parameterized (works for any system).
- `findCrossSystemArbitrageRoutes(minProfit, limit)` (`repos.ts:560`) — pairs
  where `buySystem != sellSystem`. `rankCrossRoutes`/`crossRouteNetProfit`
  explicitly SKIP same-system routes.
- `pickLocalRoute` (`coordinator/localSource.ts`), `pickCrossRoute`
  (`coordinator/crossSource.ts`) — claim-aware pickers.
- `partitionFleet` (`coordinator/fleetPlan.ts`) — splits earners into
  contractor / cross / **remote** / local buckets (see §4).

---

## 4. What was built this session (remote in-system traders)

**Commit `bba6c0a` — `feat(fleet): add remote in-system traders`** (local, NOT pushed).

Motivation: every remote trade was forced back through the home jump gate (buy
remote → jump home → sell), which auto-buys ~5,000 antimatter per jump and burns
~30-min round trips. A 384k ANTIMATTER cross-run netted only +11,720 (~161/u).
Trading *inside* a remote system removes the jump cost and round-trip latency.

Changes (4 files, +194 lines; `tsc` EXIT 0; suite **303 pass / 0 fail**, +4 tests):

1. **`src/coordinator/fleetPlan.ts`** — `partitionFleet` gains a `remote` bucket.
   - New types `RemoteSystemSpec { system; ships }` and `RemoteTrader { ship; system }`.
   - New option `remoteSystems?: RemoteSystemSpec[]`.
   - Allocation order from the range-ranked pool: contractor (by hold) → cross
     (top fuel) → **remote** (next-highest range, filled system-by-system in list
     order) → local (rest). Remote picked after cross because they make a one-time
     relocation jump and must self-refuel out there.
   - Backwards compatible: empty `remoteSystems` → `remote: []`, identical to before.
2. **`src/test/fleetPlan.test.ts`** — +4 tests: allocation order; multi-system
   fill order; quota-beyond-pool; backwards-compat (no remoteSystems).
3. **`src/agents/shipAgent.ts`** — `ShipRole` widened with `'remote'`. It reuses
   the existing `local` control flow (in-system loop) via the role else-branch;
   no logic change needed. Header doc updated.
4. **`src/fleet.ts`** — wiring:
   - New env `REMOTE_TRADE_SYSTEMS` (comma list) + `REMOTE_TRADE_SHIPS`
     (count per listed system, default 1). OFF by default (no systems listed).
   - Hydrates each remote trade system at startup (waypoints + market structures
     + jump gate), guarded by try/catch.
   - `depsFor(tradeSystem)` + `localCandidatesFor(sys)` — remote traders read
     their own system's `findArbitrageRoutes`, not home's.
   - `launch(ship, role, tradeSystem)` — if `tradeSystem !== home` and the ship
     isn't already there, relocate ONCE via `crossSystemTravelTo` to that system's
     gate. Degrades gracefully: trades wherever it lands if relocation fails
     (uses `systemOf(s.nav.waypointSymbol)` as the effective system for
     candidates + drain + opts.system).
   - `syncAgents` builds the `remoteSystems` spec from env and launches the
     remote bucket; agents log line now shows `remote=[SYM@SYSTEM]`.
   - New `remote{trips,profit}` stats bucket in the per-minute stats line and the
     shutdown summary.

### How to enable / scale
```
REMOTE_TRADE_SYSTEMS=X1-FU76 REMOTE_TRADE_SHIPS=1 ...   # one trader in FU76
REMOTE_TRADE_SYSTEMS=X1-FU76,X1-CN42 REMOTE_TRADE_SHIPS=1 ...  # add CN42 later
```
Scale CN42 only AFTER its market coverage is hydrated (currently ~1 market).

---

## 5. Prior session work (already pushed to origin/master)

Up to and including `532ddb2` is on `origin/master`. `bba6c0a` is the only
unpushed commit (`ahead 1`).

- `532ddb2` fix(fleet): tolerate server-corrupted ships during roster hydrate —
  `listAllShips()` is resilient: fast `limit=20` bulk paging; on a 5xx falls back
  to per-ship `limit=1` scan that SKIPS any ship the server can't serialize;
  skipped ship auto-rejoins once the server heals. `hydrateShips` delegates to it.
  (+4 tests in `src/test/hydrateShips.test.ts`.)
- `e9e10bd` feat(scout): reserve flex probes for ongoing neighbor discovery.
- `ae57f7f` refactor(scout): decouple remote scout from the probe cycle.
- `6fbbca8` fix(scout): measure remote-scout budget from arrival, not travel.
- `1d045c1` fix(fleet): page through the full ship roster instead of the first 20.
- `d8fa589` fix(provision): cap probe buys per cycle + guard overlapping cycles.
- `717f016` fix(fleet): idle with backoff when a claimed route does not trade.
- (earlier) probe ranking by neighbor trade volume, feeder auto-restart, gate
  supply MAX_PRICE cap, importance-weighted probe placement, F48 factory-feed +
  EXCLUDE_SHIPS, live-wallet per-trade budget cap.

---

## 6. Live runtime state (as of this handoff)

- **Fleet process:** pid **89830**, running. Launched 16:10 with
  `REMOTE_TRADE_SYSTEMS=X1-FU76 REMOTE_TRADE_SHIPS=1 MAX_PROBES=70 SCOUT_PROBES=3 CROSS_SHIPS=2`.
- **Baseline credits this run:** 2,865,796. Bouncing 2.81M–2.97M as cross capital
  cycles (deploy→realize; profit=0 cross trips are noisy aborted iterations, not loss).
- **Agent partition (live):**
  - contractor = AGENT-4
  - cross = [AGENT-5, AGENT-1]
  - **remote = [AGENT-2E @ X1-FU76]**  ← the new remote in-system trader
  - local = [AGENT-6, AGENT-7, AGENT-8, AGENT-9]
- **AGENT-2E status:** relocating to FU76 (navigating to home gate X1-A20-I56 to
  jump). First FU76 in-system trade had NOT landed yet at handoff time — gated
  purely on travel time, no errors.
- **AGENT-3:** periodically corrupt server-side (direct GET 500s, code 3000).
  Resilient hydrate skips it on boot; it auto-rejoins when the server heals.

### Launch / monitor / test commands
```bash
# Launch (current live config)
REMOTE_TRADE_SYSTEMS=X1-FU76 REMOTE_TRADE_SHIPS=1 MAX_PROBES=70 SCOUT_PROBES=3 CROSS_SHIPS=2 \
  nohup npx tsx src/fleet.ts > /tmp/fleet.log 2>&1 &

# Monitor
rg "stats \| credits|remote\{trips|2E" /tmp/fleet.log | tail
rg "agents:|relocating|agent crashed" /tmp/fleet.log | tail

# Typecheck + tests
npx tsc --noEmit
node --test --import tsx src/test/*.test.ts

# Graceful drain then restart (drain may not converge due to long scout loop /
# cross jumps — cargo is safe server-side, so SIGKILL after a reasonable wait):
kill -TERM <pid>   # wait ~2-3 min, then if still running:
kill -KILL <pid>
mv /tmp/fleet.log /tmp/fleet.log.prevN   # rotate before relaunch
```

---

## 7. Key tuning constants (`src/fleet.ts` CFG / env)

- `RESERVE` = 75000, `maxShips` = 8, `maxProbesPerCycle` = 3, `maxTradeFraction` = 0.25.
- Intervals: reinvest/provision/scout = 600_000ms (first tick after 10 min);
  probe = 120_000ms; stats = 60_000ms.
- `MIN_PROFIT` default 20; `CROSS_SHIPS` default 2; `REMOTE_TRADE_SHIPS` default 1.
- `CROSS_ANTIMATTER_COST` default 0 (jump cost not yet charged into cross ranking).

---

## 8. Jump network & markets (live knowledge)

- Home gate: **X1-A20-I56** (construction COMPLETE).
- Direct neighbors via gate:
  - **X1-FU76** ✅ charted, 7 markets / 5 hydrated (good remote-trade target).
  - **X1-CN42** ⚠️ charted, 29 marketplaces + 3 shipyards, only ~1 hydrated
    (needs probe coverage before stationing a remote trader).
  - **X1-CY96, X1-GK27, X1-AM47** — UNEXPLORED direct neighbors.
  - 2nd-hop: FF42 / FV35 / KV89 / AX61 / XB38 / VJ35 / AB13.
- Best cross margins observed (live): CLOTHING A20→FU76 ~1,668/u,
  MACHINERY FU76→A20 ~1,414/u. ANTIMATTER CN42→FU76 only ~161–184/u (thin —
  the motivating example for remote in-system trading).

---

## 9. Known issues / gotchas

- **Cross-trader is slow + noisy:** re-plans each cycle and can latch onto a
  thin-margin good (e.g. ANTIMATTER ~161/u), inflating `cross{trips}` with
  profit=0 until the real sale lands. Cargo never lost.
- **No min-margin floor on cross trades yet** — a 384k position can tie up the
  wallet for ~+12k. Candidate follow-up: skip cross goods under ~500/u or <10%.
- **Cross stats under-count / re-attribute** when a cross agent hits "agent done"
  and relaunches. Credits are the source of truth, not the stats bucket.
- **Drain rarely converges** (long ~50-min scout loop + cross jump cooldowns keep
  the process alive). SIGKILL after a graceful attempt — cargo is safe server-side.
- **AGENT-3 500-storm:** each full-roster call incurs a 5-retry 500 storm on its
  page while corrupt; per-ship fallback paging is slow (~40s). Optional
  follow-up: cache the corrupt-ship symbol to skip the retry storm.
- **Log timestamps are +4h** ahead of wall clock (nav arrival strings too).
- `systems` DB table is EMPTY; only `waypoints` is populated.
- Tooling quirks: `gh` CLI broken (GITHUB_TOKEN 401); `fd` not installed;
  `rg -E` rejects the regex flag; shell `sleep` >120s exceeds the tool timeout
  (use ≤110s).

---

## 10. Next steps (pick up here)

1. **Confirm AGENT-2E's first FU76 in-system trade lands** (proof of end-to-end);
   watch `remote{trips,profit}` start accruing with no jump-home cost.
2. **Decide rollout scaling:** if FU76 proves out, bump `REMOTE_TRADE_SHIPS` or add
   `X1-CN42` (only after raising CN42 probe/market coverage).
3. **Optional:** push `bba6c0a` to origin (currently local only — push only when asked).
4. **Optional tuning:** add a min-margin floor to the cross-trader so big capital
   stops flowing into thin-margin goods (ANTIMATTER); cache corrupt-ship symbol
   to skip the 500-retry storm.

---

## 11. Key files map

- `src/fleet.ts` — live continuous-fleet entrypoint; CFG/env, hydration, agent
  launch + relocation, maintenance timers, stats.
- `src/agents/shipAgent.ts` — per-ship perpetual loop; roles incl. `remote`.
- `src/agents/probeAgent.ts`, `src/agents/scoutAgent.ts` — probe + decoupled scout loops.
- `src/coordinator/fleetPlan.ts` — `partitionFleet` (contractor/cross/remote/local).
- `src/coordinator/localSource.ts`, `crossSource.ts`, `claimRegistry.ts` — pickers + claims.
- `src/behaviors/trader.ts` (`runRoute`, `scanHere`, `drainStrandedCargo`),
  `remoteTrader.ts` (`runRemoteTrade`), `contractPipeline.ts`, `stationKeeper.ts`,
  `remoteScout.ts`, `scanner.ts`, `buyer.ts`, `trade.ts`.
- `src/util/crossNav.ts` (`crossSystemTravelTo`), `crossRoutes.ts`, `jumpPath.ts`,
  `routes.ts`, `depth.ts`, `nav.ts`, `stations.ts`, `reinvest.ts`.
- `src/state/repos.ts` (`findArbitrageRoutes`, `findCrossSystemArbitrageRoutes`,
  gates/waypoints), `world.ts` (hydrate*), `wallet.ts`, `db.ts`, `kv.ts`.
- `src/client/api.ts` (`listAllShips` resilient), `http.ts` (`ApiError`), `rateLimiter.ts`.
- `src/fleet/maintenance.ts` — reinvest + probe provisioning.
- Tests under `src/test/*.test.ts` (run all; 303 passing).
- Logs: `/tmp/fleet.log` (current run pid 89830); prior runs `/tmp/fleet.log.prevN`.
- Repo: `molson303/spacetraders` on `master`.
