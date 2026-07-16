// GPS run recorder — foreground watch (expo-location watchPositionAsync).
//
// NOTE: background recording (screen-off) is intentionally NOT here. The
// startLocationUpdatesAsync + TaskManager + foreground-service approach crashed
// on-device (v1.6/v1.7) and is being re-done with real crash diagnostics. This
// file is deliberately back to the v1.5 shape, which worked: no expo-task-manager,
// no foreground service, no background location. Records while the app is open.
//
// No HR: phones lack a heart-rate sensor, so hasHr stays false.
import { useCallback, useEffect, useState } from "react";
import * as Location from "expo-location";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { GeoPoint, Track, Sport, sportInfo } from "./types";
import { computeSummary, haversine } from "./analytics";

const RECORDER_OPTIONS: Location.LocationOptions = {
  accuracy: Location.Accuracy.BestForNavigation,
  timeInterval: 1000, // ms
  distanceInterval: 1, // m
};

// ---- fix-quality gating -----------------------------------------------------
// Real GPS delivers junk: a stale cached first fix hundreds of km away, plus
// outlier spikes. Unfiltered, one bad fix adds thousands of km.
const MAX_ACCURACY_M = 50;
const REANCHOR_AFTER = 3;
const KEEP_AWAKE_TAG = "perun-recording";
// NOTE: the outlier speed gate is PER-SPORT (see Session.sport). A running gate
// of 12 m/s would silently drop a cycling descent and corrupt the track, which
// is why the sport must be chosen before recording starts.

export interface LiveStats {
  distanceM: number;
  durationS: number;
  paceSecPerKm: number;
  points: number;
}
const EMPTY_STATS: LiveStats = { distanceM: 0, durationS: 0, paceSecPerKm: 0, points: 0 };

export type PermissionState = "unknown" | "granted" | "denied";

export function fixToPoint(fix: Location.LocationObject): GeoPoint {
  const c = fix.coords;
  const p: GeoPoint = { lat: c.latitude, lon: c.longitude, t: fix.timestamp };
  if (c.altitude != null) p.alt = c.altitude;
  if (c.speed != null && c.speed >= 0) p.speed = c.speed;
  return p;
}

function statsFrom(points: GeoPoint[]): LiveStats {
  if (points.length < 2) return { ...EMPTY_STATS, points: points.length };
  const s = computeSummary({ hasAlt: true, points });
  return { distanceM: s.distanceM, durationS: s.durationS, paceSecPerKm: s.avgPaceSecPerKm, points: points.length };
}

// Module-level session so the in-progress run isn't tied to a component.
class Session {
  points: GeoPoint[] = [];
  recording = false;
  paused = false;
  startedAt = 0;
  /** Chosen at start — gates outlier speed and picks pace-vs-speed display. */
  sport: Sport = "running";
  private rejectStreak = 0;
  /** Wall-clock spent paused, so live duration shows MOVING time. */
  private pausedAccumMs = 0;
  private pausedAt = 0;
  /** Set on resume; tags the next accepted fix as opening a new <trkseg>. */
  private pendingBrk = false;
  private listeners = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
  private emit() { this.listeners.forEach((l) => l()); }

  begin(sport: Sport) {
    this.points = []; this.rejectStreak = 0; this.startedAt = Date.now();
    this.paused = false; this.pausedAccumMs = 0; this.pausedAt = 0;
    this.pendingBrk = false;
    this.sport = sport; this.recording = true; this.emit();
  }
  end() { this.recording = false; this.paused = false; this.emit(); }

  pause() {
    if (!this.recording || this.paused) return;
    this.paused = true; this.pausedAt = Date.now(); this.emit();
  }
  resume() {
    if (!this.recording || !this.paused) return;
    this.pausedAccumMs += Date.now() - this.pausedAt;
    this.paused = false; this.pausedAt = 0;
    // The next fix starts a new segment. Without this the resume point would be
    // joined to the pre-pause point and the gap counted as distance.
    this.pendingBrk = true;
    this.rejectStreak = 0;
    this.emit();
  }
  /** Paused wall-clock so far, including an in-progress pause. */
  pausedMs(): number {
    return this.pausedAccumMs + (this.paused && this.pausedAt ? Date.now() - this.pausedAt : 0);
  }

  ingest(fix: Location.LocationObject) {
    if (!this.recording || this.paused) return;
    const acc = fix.coords.accuracy;
    if (acc != null && acc > MAX_ACCURACY_M) return;

    const p = fixToPoint(fix);
    const prev = this.points[this.points.length - 1];
    if (!prev) { this.points.push(p); this.rejectStreak = 0; this.emit(); return; }

    // First fix after a resume: accept unconditionally and open a new segment.
    // The speed gate MUST be skipped here — you may legitimately have resumed
    // far away, and that jump is exactly what the break exists to represent.
    if (this.pendingBrk) {
      p.brk = true;
      this.points.push(p); this.pendingBrk = false; this.rejectStreak = 0;
      this.emit(); return;
    }

    const dt = Math.max(0.001, (p.t - prev.t) / 1000);
    const speed = haversine(prev.lat, prev.lon, p.lat, p.lon) / dt;
    // Per-sport gate: a running 12 m/s limit would drop a cycling descent.
    if (speed <= sportInfo(this.sport).maxSpeedMps) {
      this.points.push(p); this.rejectStreak = 0; this.emit(); return;
    }

    this.rejectStreak++;
    // Lone anchor keeps diverging ⇒ it was the stale first fix; re-anchor.
    if (this.points.length === 1 && this.rejectStreak >= 2) {
      this.points[0] = p; this.rejectStreak = 0; this.emit(); return;
    }
    // Sustained divergence (long dropout) ⇒ accept forward so we don't stall.
    if (this.rejectStreak >= REANCHOR_AFTER) { this.points.push(p); this.rejectStreak = 0; this.emit(); return; }
  }

  toTrack(name?: string): Track {
    return { name, sport: this.sport, hasAlt: true, hasHr: false, points: this.points.slice() };
  }

  liveStats(): LiveStats {
    const stats = statsFrom(this.points);
    // Tick duration off wall-clock so the timer moves between fixes — but net of
    // paused time, so it freezes while paused and matches the saved run's
    // moving time.
    if (this.recording && this.startedAt) {
      const movingMs = Date.now() - this.startedAt - this.pausedMs();
      stats.durationS = Math.max(stats.durationS, movingMs / 1000);
    }
    return stats;
  }
}

export const session = new Session();
let fgSub: Location.LocationSubscription | null = null;

/** No-op kept so callers (App.tsx) stay stable while background recording is out. */
export async function clearStaleTask(): Promise<void> { /* nothing registered */ }

async function requestForeground(): Promise<PermissionState> {
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    return fg.granted ? "granted" : "denied";
  } catch {
    return "denied";
  }
}

/** Start recording (foreground only). false if location permission was denied. */
export async function startRecording(sport: Sport = "running"): Promise<boolean> {
  if ((await requestForeground()) !== "granted") return false;
  session.begin(sport);
  try {
    fgSub = await Location.watchPositionAsync(RECORDER_OPTIONS, (fix) => session.ingest(fix));
    return true;
  } catch (e) {
    console.log("[perun] watchPositionAsync failed:", e);
    session.end();
    return false;
  }
}

/** Stop recording and return the finished Track. Never throws. */
export async function stopRecording(): Promise<Track> {
  session.end();
  if (fgSub) { try { fgSub.remove(); } catch { /* ignore */ } fgSub = null; }
  return session.toTrack();
}

// -----------------------------------------------------------------------------
// GPS readiness probe (start screen only)
// -----------------------------------------------------------------------------
export interface GpsStatus {
  /** Last known horizontal accuracy, metres. null = no fix yet. */
  accuracyM: number | null;
  /** Accurate enough that the recorder would accept the fix. */
  ready: boolean;
}

/** Watch GPS while the start dock is up, so you can see whether it has a lock
 *  BEFORE committing to a run.
 *
 *  This also warms the receiver: the worst GPS data is the first fix after a
 *  cold start (that's the stale-cached-fix that produced the 9253 km bug), so
 *  by the time you press Record the chip is green and the fix is real. Probing
 *  stops the moment recording starts — the recorder runs its own watch, and two
 *  concurrent watches would just burn battery. */
export function useGpsProbe(enabled: boolean): GpsStatus {
  const [status, setStatus] = useState<GpsStatus>({ accuracyM: null, ready: false });

  useEffect(() => {
    if (!enabled) { setStatus({ accuracyM: null, ready: false }); return; }
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      try {
        const fg = await Location.getForegroundPermissionsAsync();
        if (!fg.granted || cancelled) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 2000, distanceInterval: 0 },
          (fix) => {
            const acc = fix.coords.accuracy ?? null;
            setStatus({ accuracyM: acc, ready: acc != null && acc <= MAX_ACCURACY_M });
          }
        );
      } catch {
        /* probe is best-effort — never block starting a run on it */
      }
    })();
    return () => {
      cancelled = true;
      if (sub) { try { sub.remove(); } catch { /* ignore */ } }
    };
  }, [enabled]);

  return status;
}

// -----------------------------------------------------------------------------
// React hook
// -----------------------------------------------------------------------------
export interface UseRecorder {
  isRecording: boolean;
  isPaused: boolean;
  points: GeoPoint[];
  liveStats: LiveStats;
  permissionDenied: boolean;
  sport: Sport;
  start: (sport?: Sport) => Promise<boolean>;
  pause: () => void;
  resume: () => void;
  stop: () => Promise<Track>;
}

export function useRecorder(): UseRecorder {
  const [isRecording, setIsRecording] = useState(session.recording);
  const [isPaused, setIsPaused] = useState(session.paused);
  const [points, setPoints] = useState<GeoPoint[]>(session.points.slice());
  const [liveStats, setLiveStats] = useState<LiveStats>(session.liveStats());
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Hold a wake lock for exactly the recording session. Without it the screen
  // sleeps, the foreground watch stops delivering fixes, and the run silently
  // dies — while we're foreground-only this IS the recording feature.
  // (Imperative, not useKeepAwake(): that hook activates unconditionally on
  // mount, which would pin the screen on even when idle.)
  // TODO: once background recording lands, demote this to a "keep screen on"
  // preference rather than a hard requirement.
  useEffect(() => {
    if (!isRecording) return;
    activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => { /* non-fatal */ });
    return () => { try { deactivateKeepAwake(KEEP_AWAKE_TAG); } catch { /* ignore */ } };
  }, [isRecording]);

  useEffect(() => {
    return session.subscribe(() => {
      setPoints(session.points.slice());
      setLiveStats(session.liveStats());
      setIsRecording(session.recording);
      setIsPaused(session.paused);
    });
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    const id = setInterval(() => setLiveStats(session.liveStats()), 1000);
    return () => clearInterval(id);
  }, [isRecording]);

  // Tear down the OS subscription if the app unmounts mid-run.
  useEffect(() => {
    return () => { if (session.recording) void stopRecording(); };
  }, []);

  const start = useCallback(async (sport: Sport = "running") => {
    const ok = await startRecording(sport);
    setPermissionDenied(!ok);
    if (ok) {
      setPoints([]); setLiveStats(session.liveStats());
      setIsRecording(true); setIsPaused(false);
    }
    return ok;
  }, []);

  const pause = useCallback(() => session.pause(), []);
  const resume = useCallback(() => session.resume(), []);

  const stop = useCallback(async () => {
    const track = await stopRecording();
    setIsRecording(false);
    setIsPaused(false);
    setLiveStats(session.liveStats());
    return track;
  }, []);

  return {
    isRecording, isPaused, points, liveStats, permissionDenied,
    sport: session.sport, start, pause, resume, stop,
  };
}
