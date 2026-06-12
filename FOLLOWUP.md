# Follow-up work

Tracked engineering follow-ups discovered during live operation. Not blocking —
the fleet is profitable and cross-system arbitrage is unblocked — but each
improves throughput or coverage.

## 1. Decouple `remoteScout` from the probe cycle

**Problem.** `runProbeCycle` (`src/agents/probeAgent.ts`) awaits the flex
probe's `runRemoteScout` inline. A fuel-free scout's round trip is ~50 min
(~24 min crawl to the gate each way + jump + in-system scans), and the cycle
cannot return — so **no station-keeping refresh runs during that window**,
neither for home markets nor for newly-assigned cross-system stations. This is
the main bottleneck delaying neighbor price hydration and the first real
`xarb`.

**Fix sketch.** Run the remote scout on its own cadence/task, independent of the
station-keeping pass, so home + cross stations keep refreshing while a scout is
out. Options: a separate long-interval scout agent, or fire-and-forget the scout
from the cycle without awaiting it (guarding against overlapping scout runs,
e.g. with `nonReentrant`).

**Acceptance.** While a scout is mid-trip, `station keeping:` / `probe pass:`
lines continue to log on the normal interval; cross-system station prices
hydrate without waiting for the scout to return.

## 2. Reserve flex probes for ongoing neighbor discovery

**Problem.** Once `planProbeStations` assigns every probe to a market
(observed: `provision: 34/36 market(s) stationed (34 probe(s))`), the flex pool
is **0**, so `partitionProbes` yields no probe for `runRemoteScout`. Further
neighbor systems (X1-CN42, etc.) then never get discovered — discovery stalls at
whatever was already scanned. X1-FU76 alone enables cross-arb, but broader
expansion is capped.

**Fix sketch.** Reserve N probes (env, e.g. `SCOUT_PROBES=1`) as permanent flex
scouts that `planProbeStations` is not allowed to consume, or raise `MAX_PROBES`
so there is always headroom beyond the covered-market count. Re-evaluate the
home-vs-neighbor station priority so neighbor coverage and active discovery
coexist.

**Acceptance.** With markets fully covered, at least one probe remains flex and
`remoteScout` keeps discovering unscanned neighbors over successive cycles.

---

### Context (live run, 2026-06-12)
- Fix already shipped: `fix(scout): measure remote-scout budget from arrival,
  not travel` (commit `6fbbca8`) — neighbor markets now actually get scanned
  after the long travel leg. `SCOUT_BUDGET_MS` default 10m, decoupled from the
  local scanner's `SCAN_BUDGET_MS`.
- These two items are throughput/coverage improvements layered on top of that
  correctness fix.
