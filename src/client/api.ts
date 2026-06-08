import type {
  Agent,
  ApiItem,
  ApiList,
  Contract,
  Extraction,
  Market,
  Ship,
  ShipCargo,
  ShipCooldown,
  ShipNav,
  ShipType,
  Shipyard,
  Survey,
  Waypoint,
  FlightMode,
} from '../types/index.js';
import { HttpClient } from './http.js';
import { RateLimiter } from './rateLimiter.js';

/* Thin typed wrapper over the SpaceTraders REST endpoints. */

export interface PageQuery {
  page?: number;
  limit?: number;
}

export class SpaceTradersApi {
  readonly http: HttpClient;
  readonly limiter: RateLimiter;

  constructor(limiter?: RateLimiter) {
    this.limiter =
      limiter ??
      new RateLimiter({
        ratePerSecond: Number(process.env.RL_PER_SECOND ?? 2),
        burst: Number(process.env.RL_BURST ?? 25),
      });
    this.http = new HttpClient(this.limiter);
  }

  // ---------- Agent ----------
  async getMyAgent(): Promise<Agent> {
    return (await this.http.get<ApiItem<Agent>>('/my/agent')).data;
  }

  // ---------- Systems / Waypoints ----------
  async getSystemWaypoints(
    system: string,
    query: PageQuery & { type?: string; traits?: string | string[] } = {},
  ): Promise<ApiList<Waypoint>> {
    return this.http.get<ApiList<Waypoint>>(`/systems/${system}/waypoints`, {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      type: query.type,
      traits: query.traits,
    });
  }

  async getWaypoint(system: string, waypoint: string): Promise<Waypoint> {
    return (await this.http.get<ApiItem<Waypoint>>(`/systems/${system}/waypoints/${waypoint}`)).data;
  }

  async getMarket(system: string, waypoint: string): Promise<Market> {
    return (await this.http.get<ApiItem<Market>>(`/systems/${system}/waypoints/${waypoint}/market`))
      .data;
  }

  async getShipyard(system: string, waypoint: string): Promise<Shipyard> {
    return (
      await this.http.get<ApiItem<Shipyard>>(`/systems/${system}/waypoints/${waypoint}/shipyard`)
    ).data;
  }

  // ---------- Contracts ----------
  async listContracts(query: PageQuery = {}): Promise<ApiList<Contract>> {
    return this.http.get<ApiList<Contract>>('/my/contracts', {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  async acceptContract(id: string): Promise<{ agent: Agent; contract: Contract }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; contract: Contract }>>(
        `/my/contracts/${id}/accept`,
      )
    ).data;
  }

  async deliverContract(
    id: string,
    shipSymbol: string,
    tradeSymbol: string,
    units: number,
  ): Promise<{ contract: Contract; cargo: ShipCargo }> {
    return (
      await this.http.post<ApiItem<{ contract: Contract; cargo: ShipCargo }>>(
        `/my/contracts/${id}/deliver`,
        { shipSymbol, tradeSymbol, units },
      )
    ).data;
  }

  async fulfillContract(id: string): Promise<{ agent: Agent; contract: Contract }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; contract: Contract }>>(
        `/my/contracts/${id}/fulfill`,
      )
    ).data;
  }

  async negotiateContract(shipSymbol: string): Promise<{ contract: Contract }> {
    return (
      await this.http.post<ApiItem<{ contract: Contract }>>(
        `/my/ships/${shipSymbol}/negotiate/contract`,
      )
    ).data;
  }

  // ---------- Fleet: read ----------
  async listShips(query: PageQuery = {}): Promise<ApiList<Ship>> {
    return this.http.get<ApiList<Ship>>('/my/ships', {
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    });
  }

  async getShip(symbol: string): Promise<Ship> {
    return (await this.http.get<ApiItem<Ship>>(`/my/ships/${symbol}`)).data;
  }

  async getShipCargo(symbol: string): Promise<ShipCargo> {
    return (await this.http.get<ApiItem<ShipCargo>>(`/my/ships/${symbol}/cargo`)).data;
  }

  async getShipCooldown(symbol: string): Promise<ShipCooldown | null> {
    // Returns 204 (undefined) when there is no active cooldown.
    const res = await this.http.get<ApiItem<ShipCooldown> | undefined>(
      `/my/ships/${symbol}/cooldown`,
    );
    return res?.data ?? null;
  }

  // ---------- Fleet: purchase ----------
  async purchaseShip(
    shipType: ShipType,
    waypointSymbol: string,
  ): Promise<{ agent: Agent; ship: Ship; transaction: unknown }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; ship: Ship; transaction: unknown }>>(
        '/my/ships',
        { shipType, waypointSymbol },
      )
    ).data;
  }

  // ---------- Fleet: navigation ----------
  async orbitShip(symbol: string): Promise<{ nav: ShipNav }> {
    return (await this.http.post<ApiItem<{ nav: ShipNav }>>(`/my/ships/${symbol}/orbit`)).data;
  }

  async dockShip(symbol: string): Promise<{ nav: ShipNav }> {
    return (await this.http.post<ApiItem<{ nav: ShipNav }>>(`/my/ships/${symbol}/dock`)).data;
  }

  async navigateShip(
    symbol: string,
    waypointSymbol: string,
  ): Promise<{ nav: ShipNav; fuel: Ship['fuel'] }> {
    return (
      await this.http.post<ApiItem<{ nav: ShipNav; fuel: Ship['fuel'] }>>(
        `/my/ships/${symbol}/navigate`,
        { waypointSymbol },
      )
    ).data;
  }

  async patchNav(symbol: string, flightMode: FlightMode): Promise<{ nav: ShipNav }> {
    return (
      await this.http.patch<ApiItem<{ nav: ShipNav }>>(`/my/ships/${symbol}/nav`, { flightMode })
    ).data;
  }

  async refuelShip(
    symbol: string,
    opts: { units?: number; fromCargo?: boolean } = {},
  ): Promise<{ agent: Agent; fuel: Ship['fuel']; transaction: unknown }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; fuel: Ship['fuel']; transaction: unknown }>>(
        `/my/ships/${symbol}/refuel`,
        { units: opts.units, fromCargo: opts.fromCargo },
      )
    ).data;
  }

  // ---------- Fleet: maintenance / repair ----------
  /** Preview the repair cost (ship must be docked at a shipyard). */
  async getRepairCost(symbol: string): Promise<{ transaction: RepairTxn }> {
    return (
      await this.http.get<ApiItem<{ transaction: RepairTxn }>>(`/my/ships/${symbol}/repair`)
    ).data;
  }

  /** Repair a ship to full condition (ship must be docked at a shipyard). */
  async repairShip(symbol: string): Promise<{ agent: Agent; ship: Ship; transaction: RepairTxn }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; ship: Ship; transaction: RepairTxn }>>(
        `/my/ships/${symbol}/repair`,
      )
    ).data;
  }

  // ---------- Fleet: resource extraction ----------
  async createSurvey(symbol: string): Promise<{ surveys: Survey[]; cooldown: ShipCooldown }> {
    return (
      await this.http.post<ApiItem<{ surveys: Survey[]; cooldown: ShipCooldown }>>(
        `/my/ships/${symbol}/survey`,
      )
    ).data;
  }

  async extract(
    symbol: string,
    survey?: Survey,
  ): Promise<{ extraction: Extraction; cooldown: ShipCooldown; cargo: ShipCargo }> {
    return (
      await this.http.post<
        ApiItem<{ extraction: Extraction; cooldown: ShipCooldown; cargo: ShipCargo }>
      >(`/my/ships/${symbol}/extract`, survey ? { survey } : undefined)
    ).data;
  }

  async siphon(
    symbol: string,
  ): Promise<{ siphon: Extraction; cooldown: ShipCooldown; cargo: ShipCargo }> {
    return (
      await this.http.post<
        ApiItem<{ siphon: Extraction; cooldown: ShipCooldown; cargo: ShipCargo }>
      >(`/my/ships/${symbol}/siphon`)
    ).data;
  }

  // ---------- Fleet: cargo / market trades ----------
  async sellCargo(
    symbol: string,
    tradeSymbol: string,
    units: number,
  ): Promise<{ agent: Agent; cargo: ShipCargo; transaction: MarketTxn }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; cargo: ShipCargo; transaction: MarketTxn }>>(
        `/my/ships/${symbol}/sell`,
        { symbol: tradeSymbol, units },
      )
    ).data;
  }

  async purchaseCargo(
    symbol: string,
    tradeSymbol: string,
    units: number,
  ): Promise<{ agent: Agent; cargo: ShipCargo; transaction: MarketTxn }> {
    return (
      await this.http.post<ApiItem<{ agent: Agent; cargo: ShipCargo; transaction: MarketTxn }>>(
        `/my/ships/${symbol}/purchase`,
        { symbol: tradeSymbol, units },
      )
    ).data;
  }

  async jettison(
    symbol: string,
    tradeSymbol: string,
    units: number,
  ): Promise<{ cargo: ShipCargo }> {
    return (
      await this.http.post<ApiItem<{ cargo: ShipCargo }>>(`/my/ships/${symbol}/jettison`, {
        symbol: tradeSymbol,
        units,
      })
    ).data;
  }

  async transferCargo(
    fromSymbol: string,
    toSymbol: string,
    tradeSymbol: string,
    units: number,
  ): Promise<{ cargo: ShipCargo }> {
    return (
      await this.http.post<ApiItem<{ cargo: ShipCargo }>>(`/my/ships/${fromSymbol}/transfer`, {
        tradeSymbol,
        units,
        shipSymbol: toSymbol,
      })
    ).data;
  }
}

export interface MarketTxn {
  waypointSymbol: string;
  shipSymbol: string;
  tradeSymbol: string;
  type: 'PURCHASE' | 'SELL';
  units: number;
  pricePerUnit: number;
  totalPrice: number;
  timestamp: string;
}

export interface RepairTxn {
  shipSymbol: string;
  totalPrice: number;
  timestamp: string;
}
