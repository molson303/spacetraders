/* SpaceTraders domain types — pragmatic subset covering fields the bot uses. */

export interface Agent {
  accountId?: string;
  symbol: string;
  headquarters: string;
  credits: number;
  startingFaction: string;
  shipCount: number;
}

export interface Meta {
  total: number;
  page: number;
  limit: number;
}

export type ApiList<T> = { data: T[]; meta: Meta };
export type ApiItem<T> = { data: T };

// ---------- Waypoints / Systems ----------

export interface WaypointTrait {
  symbol: string;
  name: string;
  description: string;
}

export interface WaypointOrbital {
  symbol: string;
}

export interface Waypoint {
  symbol: string;
  systemSymbol: string;
  type: string;
  x: number;
  y: number;
  orbitals: WaypointOrbital[];
  orbits?: string;
  traits: WaypointTrait[];
  isUnderConstruction?: boolean;
  faction?: { symbol: string };
  chart?: { submittedBy?: string; submittedOn?: string; waypointSymbol?: string };
}

// ---------- Markets ----------

export interface MarketTradeGood {
  symbol: string;
  type: 'IMPORT' | 'EXPORT' | 'EXCHANGE';
  tradeVolume: number;
  supply: string;
  activity?: string;
  purchasePrice: number;
  sellPrice: number;
}

export interface MarketTransaction {
  waypointSymbol: string;
  shipSymbol: string;
  tradeSymbol: string;
  type: 'PURCHASE' | 'SELL';
  units: number;
  pricePerUnit: number;
  totalPrice: number;
  timestamp: string;
}

export interface Market {
  symbol: string;
  imports: { symbol: string }[];
  exports: { symbol: string }[];
  exchange: { symbol: string }[];
  transactions?: MarketTransaction[];
  tradeGoods?: MarketTradeGood[];
}

// ---------- Shipyards ----------

export interface ShipyardShip {
  type: string;
  name: string;
  purchasePrice: number;
  frame: { symbol: string };
  reactor: { symbol: string };
  engine: { symbol: string };
  supply?: string;
  activity?: string;
}

export interface Shipyard {
  symbol: string;
  shipTypes: { type: string }[];
  ships?: ShipyardShip[];
  transactions?: unknown[];
  modificationsFee?: number;
}

// ---------- Contracts ----------

export interface ContractDeliverGood {
  tradeSymbol: string;
  destinationSymbol: string;
  unitsRequired: number;
  unitsFulfilled: number;
}

export interface ContractTerms {
  deadline: string;
  payment: { onAccepted: number; onFulfilled: number };
  deliver?: ContractDeliverGood[];
}

export interface Contract {
  id: string;
  factionSymbol: string;
  type: string;
  terms: ContractTerms;
  accepted: boolean;
  fulfilled: boolean;
  deadlineToAccept?: string;
}

// ---------- Ships ----------

export interface ShipNavRoute {
  origin: { symbol: string; type: string; x: number; y: number };
  destination: { symbol: string; type: string; x: number; y: number };
  arrival: string;
  departureTime: string;
}

export type ShipNavStatus = 'IN_TRANSIT' | 'IN_ORBIT' | 'DOCKED';
export type FlightMode = 'DRIFT' | 'STEALTH' | 'CRUISE' | 'BURN';

export interface ShipNav {
  systemSymbol: string;
  waypointSymbol: string;
  route: ShipNavRoute;
  status: ShipNavStatus;
  flightMode: FlightMode;
}

export interface ShipFuel {
  current: number;
  capacity: number;
  consumed?: { amount: number; timestamp: string };
}

export interface ShipCargoItem {
  symbol: string;
  name: string;
  description: string;
  units: number;
}

export interface ShipCargo {
  capacity: number;
  units: number;
  inventory: ShipCargoItem[];
}

export interface ShipCooldown {
  shipSymbol: string;
  totalSeconds: number;
  remainingSeconds: number;
  expiration?: string;
}

export interface ShipMount {
  symbol: string;
  name: string;
  strength?: number;
  deposits?: string[];
}

export interface Ship {
  symbol: string;
  registration: { name: string; factionSymbol: string; role: string };
  nav: ShipNav;
  crew: { current: number; capacity: number; required: number; morale: number };
  frame: { symbol: string; name: string };
  reactor: { symbol: string };
  engine: { symbol: string; speed: number };
  cooldown: ShipCooldown;
  modules: { symbol: string }[];
  mounts: ShipMount[];
  cargo: ShipCargo;
  fuel: ShipFuel;
}

// ---------- Extraction / Survey ----------

export interface Survey {
  signature: string;
  symbol: string;
  deposits: { symbol: string }[];
  expiration: string;
  size: string;
}

export interface Extraction {
  shipSymbol: string;
  yield: { symbol: string; units: number };
}

// ---------- Ship purchase types ----------

export type ShipType =
  | 'SHIP_PROBE'
  | 'SHIP_MINING_DRONE'
  | 'SHIP_SIPHON_DRONE'
  | 'SHIP_INTERCEPTOR'
  | 'SHIP_LIGHT_HAULER'
  | 'SHIP_COMMAND_FRIGATE'
  | 'SHIP_EXPLORER'
  | 'SHIP_HEAVY_FREIGHTER'
  | 'SHIP_LIGHT_SHUTTLE'
  | 'SHIP_ORE_HOUND'
  | 'SHIP_REFINING_FREIGHTER'
  | 'SHIP_SURVEYOR';
