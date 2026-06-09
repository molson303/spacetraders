/*
 * Pure jump-gate pathfinding. Jump gates connect to a specific set of other
 * gates (each in a different system). To travel between systems a ship hops
 * gate -> gate until it reaches a gate in the destination system, then flies
 * intra-system to the final waypoint.
 *
 * `findJumpPath` does a breadth-first search over the gate adjacency graph and
 * returns the ordered list of gates to JUMP TO (excluding the start gate). The
 * graph is supplied as callbacks so this stays dependency-free and testable:
 *   - neighbors(gate): the gate waypoints a gate connects to
 *   - systemOf(waypoint): the system a waypoint belongs to
 *
 * Returns:
 *   []        when the start gate is already in the target system
 *   [g1,..]   the gates to jump to, in order, ending in the target system
 *   undefined when no path is known (topology not hydrated / unreachable)
 */

export interface JumpPathOptions {
  /** Safety bound on hops explored (default 8). */
  maxHops?: number;
}

export function findJumpPath(
  startGate: string,
  targetSystem: string,
  neighbors: (gate: string) => string[],
  systemOf: (waypoint: string) => string,
  opts: JumpPathOptions = {},
): string[] | undefined {
  const maxHops = opts.maxHops ?? 8;
  if (systemOf(startGate) === targetSystem) return [];

  const visited = new Set<string>([startGate]);
  // queue holds [gate, pathOfJumpsToReachIt]
  let frontier: Array<{ gate: string; path: string[] }> = [{ gate: startGate, path: [] }];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: Array<{ gate: string; path: string[] }> = [];
    for (const { gate, path } of frontier) {
      for (const conn of neighbors(gate)) {
        if (visited.has(conn)) continue;
        visited.add(conn);
        const newPath = [...path, conn];
        if (systemOf(conn) === targetSystem) return newPath;
        next.push({ gate: conn, path: newPath });
      }
    }
    frontier = next;
  }

  return undefined;
}

/** Systems directly reachable from a gate in one jump (deduped). */
export function directNeighborSystems(
  gate: string,
  neighbors: (gate: string) => string[],
  systemOf: (waypoint: string) => string,
): string[] {
  const out = new Set<string>();
  for (const conn of neighbors(gate)) out.add(systemOf(conn));
  return [...out];
}
