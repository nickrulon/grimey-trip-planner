// API types — mirror server/plan.mjs + server/today.mjs responses.

export interface RiderNote {
  id: number; kind: string; title: string; detail: string;
  startMile: number; endMile: number; source: string | null; confidence: string;
}

export interface SunSummary {
  zone: string; workday: boolean;
  dawn: number | null; sunrise: number | null; sunset: number | null; dusk: number | null;
  work: {
    localStart: number; localEnd: number;
    etStart: number; etEnd: number; minutes: number;
    etDefaultStart?: number; etDefaultEnd?: number; shiftedH?: number;
  } | null;
  usableRideMin: number; bufferMin: number;
  fit: 'fits' | 'tight' | 'short';
  rideMin?: number;
  phases?: string[];
  darkBeforeMin?: number;
  darkAfterMin?: number;
  overrides?: { depart: boolean; workStart: boolean; rideUntil: boolean };
}

export interface DayTimes {
  startTime: string | null;
  workStart: string | null;
  rideUntil: string | null;
  defaultDepartMin: number;
  defaultRideUntilMin: number;
  rideFromMin: number;
  rideToMin: number | null;
}

export interface WorkStop {
  id: number; resourceId: string | null; name: string; brand: string | null;
  routeMile: number; offRouteMi: number | null; dwellMin: number; cost: number | null;
  wifiStatus: string | null; hours: string | null;
  address: string | null; phone: string | null; website: string | null;
  lat: number | null; lng: number | null;
  town?: string | null; state?: string | null;
}

export interface Readiness {
  state: string;
  issues: { kind: string; label: string }[];
}

export interface Overnight {
  id: string; name: string; category: string; offRouteMi: number | null;
  address: string | null; phone: string | null; website: string | null;
  hours: string | null; lat: number; lng: number; attributes?: string | null;
  town?: string | null; state?: string | null; routeMile: number | null;
}

export interface PlanDay {
  dayNumber: number; date?: string | null; rest: boolean;
  startMile: number; endMile: number; miles: number;
  effortMiles: number; rideTimeMin: number;
  elevGainFt: number | null; elevLossFt: number | null;
  riderNotes: RiderNote[];
  startName: string; endName: string; endState: string | null;
  lodgingCost: number | null; miscCost: number | null;
  overnightCampId: string | null;
  workStop: WorkStop | null;
  sun: SunSummary | null;
  readiness: Readiness;
  overnight: Overnight | null;
  status: string; flags: string[]; notes: string | null;
  resourceCounts: Record<string, number>;
  actual: { endMile: number; miles: number; endName: string; date: string | null; notes: string | null } | null;
}

export interface Schedule {
  startDate: string | null; arriveDate: string | null;
  plannedDays: number; projectedArrival?: string; maxDayMiles?: number;
  availableDays?: number; slackDays?: number;
  requiredAvgMiles?: number | null; daysLate?: number;
}

export interface PlanResponse {
  revision: { id: number; createdAt: string; reason: string } | null;
  days: PlanDay[];
  geometry: { lines: GeoJSON.FeatureCollection; bounds: GeoJSON.FeatureCollection } | null;
  totalMiles: number;
  schedule?: Schedule;
  history?: { id: number; created_at: string; reason: string; active: number; day_count: number }[];
  readinessRollup?: Record<string, number>;
  costs?: { total: number; avgPerDay: number };
  tripStartMile?: number;
  tripStartName?: string;
  tripMiles?: number;
}

export interface CanvasBlock {
  kind: 'ride' | 'work' | 'slack' | 'break' | 'combo';
  label: string; startMin: number; endMin: number;
  miles?: number; rideMin?: number;
  id?: number; dwellMin?: number; routeMile?: number;
}

export interface IntelRecord {
  id: string; kind: string; type: string | null; severity: number | null;
  summary: string | null; detail: string | null;
  cyclistIntel: string | null; actionable: string | null; quote: string | null;
  state: string | null; road: string | null;
  from: string | null; to: string | null; extentMi: number | null;
  startMile: number | null; endMile: number | null;
  anchorMethod: string; anchorApprox: boolean;
  observedDate: string | null; stalenessYrs: number | null; confidence: string | null;
  mustVerify: boolean; verifyTarget: string | null;
  offHighway: boolean; routingPriority: string | null;
  shade: string | null; windSheltered: string | null;
  photos: { caption: string | null; shows: string | null }[];
  milesAhead?: number; active?: boolean;
  roadMiles?: [number, number]; roadEvidence?: number;
}

export interface DayCombo {
  id: number; name: string; routeMile: number; minutes: number; note: string | null;
}

export interface DayBreak {
  id: number; name: string; routeMile: number; dwellMin: number;
  note: string | null;
  milesFromStart: number; rideMinFromStart: number;
}

/**
 * A mark is the rider's own fixed appointment drawn on the canvas: TIME-anchored
 * and mile-indifferent, which is the exact opposite of a break. The 3:30 boat
 * leaves at 3:30 whether or not you are on it, so a mark never takes the shift
 * that slides ride and work blocks when roll-out moves.
 *
 * scope 'day' pins it to a day number (the default, and what "day one in
 * particular" means). scope 'mile' pins it to a route mile instead, so it
 * follows the crossing when a replan renumbers the days.
 */
export type MarkColor = 'slate' | 'red' | 'amber' | 'green' | 'teal' | 'blue' | 'violet' | 'pink';

export interface CanvasMark {
  id: number;
  scope: 'day' | 'mile';
  label: string;
  shape: 'block' | 'line';
  color: MarkColor;
  startMin: number;
  endMin: number | null;
  notes: string | null;
  routeMile: number | null;
  dayNumber: number | null;
}

/**
 * A crossing (ferry, shuttle, lift round a closure) the day touches. Unioned
 * from two sources — route_transits rows the rider created, and ingested
 * route_notes of kind 'ferry' — so the id is prefixed, not numeric.
 */
export interface DayTransit {
  id: string; source: 'transit' | 'note';
  name: string; kind: string; minutes: number | null;
  startMile: number; endMile: number; notes: string | null;
  /** Local minute the simulated ride reaches startMile; null on a rest day. */
  atMin: number | null;
}

export interface DayCanvas {
  dayNumber: number; date: string | null; rest: boolean;
  startMile: number; endMile: number; miles: number; effortMiles: number;
  startName: string; endName: string; endState: string | null;
  status: string; flags: string[];
  prevOvernight: string;
  departMin: number;
  times: DayTimes;
  blocks: CanvasBlock[];
  conflict: { kind: string; overMin: number; detail: string } | null;
  sun: SunSummary | null;
  workStop: WorkStop | null;
  workStops: WorkStop[];
  combos: DayCombo[];
  work: { owedMin: number; creditMin: number; shortMin: number; overMin: number; comboMin: number } | null;
  breaks: DayBreak[];
  marks: CanvasMark[];
  /** Mile-pinned marks the simulated ride reaches too late. */
  missedMarks: { id: number; lateMin: number; label: string }[];
  transits: DayTransit[];
  /** True when this canvas is a dry run of a proposed chain, nothing saved. */
  preview?: boolean;
  workFallbacks: { id: string; name: string; routeMile: number; offRouteMi: number | null; wifiStatus: string | null }[];
  movingMeeting: {
    fromMile: number;
    stop: { id: string; name: string; routeMile: number; milesAhead: number; rideMin: number; wifiStatus: string | null };
    gainMi: number;
  } | null;
  sleep: {
    resource: Overnight | null;
    campSpot: (Record<string, unknown> & { name?: string; routeMile?: number }) | null;
    cost: number | null;
  };
  costs: { lodging: number | null; work: number | null; misc: number | null; total: number };
  elevGainFt: number | null;
  riderNotes: RiderNote[];
  intel: { anchored: IntelRecord[]; road: IntelRecord[]; regional: IntelRecord[] } | null;
  readiness: Readiness;
  actual: { endMile: number; miles: number; endName: string; date: string | null; notes: string | null } | null;
  dayCount: number;
}

export interface SleepOption {
  kind: 'resource' | 'camp';
  id: string; name: string; type: string;
  routeMile: number; deltaMi: number; offRouteMi: number | null;
  price: number | null; priceNote?: string | null; tier: string;
  water: boolean; showers: boolean; toilets: boolean;
  tentsOk?: boolean;
  legalityNote?: string | null; cyclistIntel?: string | null; seasonalNote?: string | null;
  booking?: string | null;
  address?: string | null; phone?: string | null; website?: string | null; hours?: string | null;
  sources?: string[]; confidence: string | null;
  lat: number; lng: number;
  town?: string | null; state?: string | null;
  cyclist: boolean; free: boolean; locationNote?: string | null;
  wifiNear: number; newDayMiles: number; deltaDayMiles: number; nextDayMiles: number | null;
  score: number; chosen: boolean;
}

export interface WorkOption {
  id: string; name: string; brand: string | null;
  routeMile: number; offRouteMi: number | null;
  wifiStatus: string | null; hours: string | null; address: string | null;
  lat: number; lng: number;
  town?: string | null; state?: string | null;
  morningMi: number; morningMin: number; afternoonMi: number; afternoonMin: number;
  score: number;
}

export interface FitOption {
  id: string; title: string; lines: string[]; assumptions: string[];
  applyable: boolean;
  diff: { dayNumber: number; endMile: number; endName: string; fromMiles: number; toMiles: number }[];
}

export interface FitOptions {
  dayNumber: number; deficitMi: number; status: string;
  options: FitOption[];
  note?: string;
}

export interface PositionInfo {
  mile: number; offRouteMi: number; lat: number; lng: number;
  nearPlace: string; totalMiles: number;
  notesAhead: (RiderNote & { milesAhead: number; active: boolean })[];
  intelAhead?: IntelRecord[];
  day: {
    dayNumber: number; endName: string; endMile: number;
    milesToEnd: number; overnightName: string | null;
  } | null;
  upcoming: {
    id: string; category: string; name: string; brand?: string | null;
    routeMile: number; milesAhead: number; offRouteMi: number | null;
    wifiStatus?: string | null; lat: number; lng: number;
    address?: string | null; phone?: string | null; website?: string | null; hours?: string | null;
    town?: string | null; state?: string | null;
  }[];
}

export interface DayWeather {
  date: string; tempF?: number; shortForecast?: string; precipPct?: number | null;
  windSpeed?: string; windDirection?: string; windClass?: string | null; error?: string;
}

export interface ReplanPreview {
  mode: 'rebuild' | 'anchors';
  baselineMile: number; afterDay: number; baselineName: string | null;
  days: {
    day_number: number; miles: number; end_name: string;
    overnightName: string | null; origMiles: number | null; deltaMiles: number | null;
    flags: string[];
  }[];
  issues: string[]; maxDayMiles: number;
  summary: { oldFinishDay: number; newFinishDay: number; dayDelta: number; remainingMiles: number };
}
