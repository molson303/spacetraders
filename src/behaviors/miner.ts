import type { SpaceTradersApi } from '../client/api.js';
import { sleep } from '../client/rateLimiter.js';
import { ensureOrbit, waitForCooldown } from '../util/nav.js';
import { upsertShip } from '../state/repos.js';
import type { Ship, Survey } from '../types/index.js';
import { createLogger } from '../util/logger.js';
import { cargoUnitsOf, sellCargoHere } from './trade.js';

const log = createLogger('miner');

export interface MineOptions {
  /** Trade symbols to keep in cargo (e.g. a contract good). */
  reserve?: Set<string>;
  /** Sell non-reserved goods at the local market between extractions. */
  sellHere?: boolean;
  /** Use the surveyor mount to improve targeting. */
  survey?: boolean;
  /** Stop once cargo holds at least this many units of `reserve` goods. */
  targetReservedUnits?: number;
  /** Max extraction cycles before returning (safety bound). */
  maxCycles?: number;
}

function hasSurveyor(ship: Ship): boolean {
  return ship.mounts.some((m) => m.symbol.includes('SURVEYOR'));
}

function reservedUnits(ship: Ship, reserve: Set<string>): number {
  let total = 0;
  for (const it of ship.cargo.inventory) if (reserve.has(it.symbol)) total += it.units;
  return total;
}

/**
 * Mine at the ship's current waypoint until cargo is full (or the reserved
 * target is reached). Periodically sells non-reserved goods at the local market
 * to free up hold space. Returns the updated ship.
 */
export async function mine(
  api: SpaceTradersApi,
  ship: Ship,
  opts: MineOptions = {},
): Promise<Ship> {
  const reserve = opts.reserve ?? new Set<string>();
  const sellHere = opts.sellHere ?? true;
  const useSurvey = (opts.survey ?? true) && hasSurveyor(ship);
  const maxCycles = opts.maxCycles ?? 100;

  let survey: Survey | undefined;
  let surveyExpires = 0;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    // Stop conditions
    if (opts.targetReservedUnits && reservedUnits(ship, reserve) >= opts.targetReservedUnits) {
      log.info(`${ship.symbol} reached reserved target (${opts.targetReservedUnits})`);
      break;
    }
    if (ship.cargo.units >= ship.cargo.capacity) {
      // Cargo full: sell non-reserved to make room, else stop.
      if (sellHere) {
        const before = ship.cargo.units;
        ({ ship } = await sellCargoHere(api, ship, { reserve }));
        ship = await ensureOrbit(api, ship);
        if (ship.cargo.units >= before) {
          log.info(`${ship.symbol} cargo full and nothing sellable here; stopping mine`);
          break;
        }
        continue;
      }
      log.info(`${ship.symbol} cargo full; stopping mine`);
      break;
    }

    ship = await ensureOrbit(api, ship);
    await waitForCooldown(api, ship.symbol);

    // Refresh / create survey if enabled.
    if (useSurvey && (!survey || Date.now() > surveyExpires)) {
      try {
        const res = await api.createSurvey(ship.symbol);
        // Prefer a survey containing a reserved deposit if we have a reserve set.
        survey =
          res.surveys.find((s) => s.deposits.some((d) => reserve.has(d.symbol))) ??
          res.surveys[0];
        surveyExpires = survey ? new Date(survey.expiration).getTime() : 0;
        // Surveying triggers a cooldown; wait it out before extracting.
        if (res.cooldown.remainingSeconds > 0) await sleep(res.cooldown.remainingSeconds * 1000 + 200);
      } catch (err) {
        log.debug(`${ship.symbol} survey failed: ${(err as Error).message}`);
        survey = undefined;
      }
    }

    try {
      const res = await api.extract(ship.symbol, survey);
      ship.cargo = res.cargo;
      upsertShip(ship);
      const y = res.extraction.yield;
      log.info(
        `${ship.symbol} extracted ${y.units} ${y.symbol} (cargo ${ship.cargo.units}/${ship.cargo.capacity})`,
      );
      if (res.cooldown.remainingSeconds > 0) {
        await sleep(res.cooldown.remainingSeconds * 1000 + 200);
      }
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('survey') || msg.toLowerCase().includes('exhausted')) {
        survey = undefined; // survey expired/exhausted; retry without it
        continue;
      }
      log.warn(`${ship.symbol} extract failed: ${msg}`);
      await sleep(1500);
    }
  }

  // Final sweep of non-reserved goods if requested.
  if (sellHere) {
    ({ ship } = await sellCargoHere(api, ship, { reserve }));
  }
  log.info(
    `${ship.symbol} mine done: reserved ${reservedUnits(ship, reserve)} units, cargo ${ship.cargo.units}/${ship.cargo.capacity}`,
  );
  return ship;
}

export { cargoUnitsOf };
