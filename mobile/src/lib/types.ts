// Shared run/track types — mirror the module's geo.h / run_analytics.h so the
// phone and the Basecamp module agree on the data model.
export interface GeoPoint {
  lat: number;
  lon: number;
  alt?: number; // metres
  hr?: number; // bpm
  speed?: number; // m/s
  t: number; // epoch ms
  /** True when a gap precedes this point — i.e. it opens a new GPX <trkseg>.
   *  Set on the first fix after a resume. Analytics must NOT bridge a break:
   *  pausing, driving home and resuming would otherwise bolt the drive onto
   *  your distance, and the outlier speed gate can't stop it (a sustained
   *  divergence gets pushed through by the re-anchor path). */
  brk?: boolean;
}

/** Sport — the standard GPX <trk><type>. Drives GPS filtering + pace-vs-speed. */
export type Sport = "running" | "trail_running" | "walking" | "hiking" | "cycling" | "mtb";

export const SPORTS: { id: Sport; label: string; foot: boolean; maxSpeedMps: number }[] = [
  // maxSpeedMps gates outlier fixes. Running's 12 m/s would silently DROP a
  // cycling descent, so this must be per-sport (see docs/wire-contract.md).
  { id: "running", label: "Run", foot: true, maxSpeedMps: 12 },
  { id: "trail_running", label: "Trail", foot: true, maxSpeedMps: 12 },
  { id: "walking", label: "Walk", foot: true, maxSpeedMps: 5 },
  { id: "hiking", label: "Hike", foot: true, maxSpeedMps: 5 },
  { id: "cycling", label: "Ride", foot: false, maxSpeedMps: 30 },
  { id: "mtb", label: "MTB", foot: false, maxSpeedMps: 25 },
];

export const sportInfo = (s?: string) =>
  SPORTS.find((x) => x.id === s) ?? SPORTS[0]; // unknown/legacy → running

export interface Track {
  name?: string;
  /** Sport — serialized as the standard GPX <trk><type> (running, cycling, …). */
  sport?: Sport;
  /** Training intent (Easy/Tempo/…) — serialized as a <perun:category> extension. */
  category?: string;
  hasAlt?: boolean;
  hasHr?: boolean;
  points: GeoPoint[];
}

/** Built-in training categories; a run may also carry any custom string. */
export const CATEGORIES = ["Easy", "Long", "Tempo", "Intervals", "Race", "Recovery"] as const;

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
  /** Mirrors track.sport (GPX <type>). */
  sport?: Sport;
  /** Mirrors track.category (perun:category extension). */
  category?: string;
  /** Monotonic revision; bumped on every edit so re-syncs replace, not dedupe. */
  rev: number;
  startTs: number;
  summary: RunSummary;
  splits: Split[];
  track: Track;
}
