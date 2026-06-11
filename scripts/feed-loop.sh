#!/usr/bin/env bash
# Auto-restart wrapper for the F48 factory feeder during the gate push.
# The feeder self-terminates whenever F48's inputs are saturated; this loop
# re-runs it after a cooldown so FAB_MATS stays ABUNDANT/cheap while supplyGate
# drains it. Exits once the gate construction is COMPLETE (or when killed).
set -u
cd "$(dirname "$0")/.."

GATE_LOG="/tmp/gate.log"
FEED_LOG="/tmp/feed.log"
COOLDOWN="${COOLDOWN:-150}"
# Protected credit floor for input buys. Inputs are cheap (IRON/QUARTZ_SAND),
# so keep this low enough that the feeder can actually run while credits are
# being rebuilt after a price spike. Override via env.
FLOOR="${FLOOR:-400000}"

while true; do
  if [ -f "$GATE_LOG" ] && rg -q "construction COMPLETE" "$GATE_LOG" 2>/dev/null; then
    echo "feed-loop: gate complete — stopping feeder loop" | tee -a "$FEED_LOG"
    break
  fi
  echo "feed-loop: starting feeder pass at $(date '+%H:%M:%S')" >> "$FEED_LOG"
  HAULER=OLSON_AGENT-5 \
  FACTORY=X1-A20-F48 \
  INPUTS=IRON,QUARTZ_SAND \
  EXPORT_GOOD=FAB_MATS \
  FLOOR="$FLOOR" \
    npx tsx src/scripts/feedFactory.ts >> "$FEED_LOG" 2>&1
  # Re-check completion before sleeping so we exit promptly.
  if [ -f "$GATE_LOG" ] && rg -q "construction COMPLETE" "$GATE_LOG" 2>/dev/null; then
    echo "feed-loop: gate complete — stopping feeder loop" | tee -a "$FEED_LOG"
    break
  fi
  echo "feed-loop: feeder exited; cooldown ${COOLDOWN}s" >> "$FEED_LOG"
  sleep "$COOLDOWN"
done
