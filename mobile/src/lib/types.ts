// Shared run/track types — mirror the module's geo.h / run_analytics.h so the
// phone and the Basecamp module agree on the data model.
export interface GeoPoint {
  lat: number;
  lon: number;
  alt?: number; // metres
  hr?: number; // bpm
  speed?: number; // m/s
  t: number; // epoch ms
}

export interface Track {
  name?: string;
  hasAlt?: boolean;
  hasHr?: boolean;
  points: GeoPoint[];
}

export interface RunSummary {
  distanceM: number;
  durationS: number;
  avgSpeedMps: number;
  avgPaceSecPerKm: number;
  elevGainM: number;
  avgHr: number;
  hasHr: boolean;
}

export interface Split {
  index: number;
  distanceM: number;
  durationS: number;
  paceSecPerKm: number;
  elevGainM: number;
  avgHr: number;
}

export interface Run {
  id: string;
  name: string;
  startTs: number;
  summary: RunSummary;
  splits: Split[];
  track: Track;
}
