import React, { useEffect, useRef, useState } from "react";
import {
  SafeAreaView, View, Text, Pressable, SectionList, ScrollView,
  StyleSheet, StatusBar, Dimensions, Alert, Linking, BackHandler,
} from "react-native";
import { Run, Track, Sport, Split, SPORTS, sportInfo } from "./src/lib/types";
import { Identity } from "./src/lib/identity";
import {
  computeSummary, computeSplits, fmtDist, fmtPace, fmtDur, fmtElev,
  fmtRate, rateLabel, fmtDate, groupByWeek, tailByDistance,
} from "./src/lib/analytics";
import { useRecorder, useGpsProbe, clearStaleTask } from "./src/lib/recorder";
import { loadRuns, saveRun, deleteRun } from "./src/lib/store";
import { loadIdentity } from "./src/lib/identityStore";
import { exportRun } from "./src/lib/gpxExport";
import { shareViewImage } from "./src/lib/imageExport";
import { syncRun } from "./src/lib/runSync";
import { deliveryAvailable } from "./src/lib/delivery";
import { startAnnotationReceive, useAnnotations } from "./src/lib/annotations";
import { RunAnnotations } from "./src/components/Annotations";
import { QuickAnnotate } from "./src/components/QuickAnnotate";
import { SharedNodeStatus } from "./src/lib/loam-transport-pkg/src/SharedNodeStatus";
import { RouteMap } from "./src/components/RouteMap";
import { ElevationChart } from "./src/components/ElevationChart";
import { RunMeta } from "./src/components/RunMeta";
import { HoldButton } from "./src/components/HoldButton";
import { Countdown } from "./src/components/Countdown";
import { PairingScreen } from "./src/components/PairingScreen";
import { theme } from "./src/theme";

function makeRun(track: Track, id: string): Run {
  return {
    id,
    name: track.name || "Run",
    sport: track.sport,
    category: track.category,
    rev: 1,
    startTs: track.points[0]?.t ?? Date.now(),
    summary: computeSummary(track),
    splits: computeSplits(track),
    track,
  };
}

const W = () => Dimensions.get("window").width - 32;

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);
  const [paired, setPaired] = useState<Identity | null>(null);
  const [pairing, setPairing] = useState(false);
  const [pairUri, setPairUri] = useState<string | null>(null); // prefill from a deep link
  // Sport must be chosen BEFORE recording: it sets the outlier speed gate (a
  // running gate would silently drop a cycling descent) and pace-vs-speed.
  const [sport, setSport] = useState<Sport>("running");
  const [counting, setCounting] = useState(false);
  // Recording-map view (issue #1): follow = zoomed crop around the current
  // location; full = the whole route. `followM` is the crop radius in metres
  // (the +/- zoom). Lifted here because the recording UI lives in a conditional
  // branch of this component and hooks can't be conditional.
  const [mapFollow, setMapFollow] = useState(false);
  const [followM, setFollowM] = useState(150);
  const rec = useRecorder();
  // Probe (and warm) the GPS only while the start dock is actually on screen.
  const gps = useGpsProbe(!rec.isRecording && !selected && !pairing && !counting);

  useEffect(() => { loadRuns().then(setRuns); }, []);

  // Self-heal: a location task left registered by a crashed run can be restored
  // at launch and crash-loop the app. Clear any stale one on start.
  useEffect(() => { clearStaleTask(); }, []);
  useEffect(() => { loadIdentity().then(setPaired); }, []);

  // Ingest annotations from the wire once paired: bring the node up, subscribe, store
  // incoming ANNOTATION envelopes (dedup by id, tombstones applied on read), and flush
  // any locally-authored ones that never made it out. Best-effort; no-op if not paired.
  useEffect(() => {
    if (!paired) return;
    let off = () => {};
    let alive = true;
    startAnnotationReceive().then((unsub) => {
      if (alive) off = unsub;
      else unsub();
    }).catch(() => {});
    return () => { alive = false; off(); };
  }, [paired]);

  // perun://pair?s=… deep link → open the pairing screen prefilled. Handles both
  // a cold start (getInitialURL) and a link arriving while the app is running.
  useEffect(() => {
    const handle = (url: string | null) => {
      if (url && url.includes("pair")) { setPairUri(url); setPairing(true); }
    };
    Linking.getInitialURL().then(handle);
    const sub = Linking.addEventListener("url", (e) => handle(e.url));
    return () => sub.remove();
  }, []);

  const openPairing = () => { setPairUri(null); setPairing(true); };

  // System back / back-gesture. Without this the app has no navigation stack, so
  // back went straight to "exit app" from every screen — including mid-run,
  // which would have silently binned the recording.
  // Order mirrors what's visually on top.
  useEffect(() => {
    const onBack = () => {
      if (counting) { setCounting(false); return true; }
      if (pairing) { setPairing(false); return true; }
      // Mid-run: swallow it. Backing out of a run must be deliberate (Hold to
      // stop), never a stray edge-swipe that loses the whole recording.
      if (rec.isRecording) return true;
      if (selected) { setSelected(null); return true; }
      return false; // on the run list: let the system close the app
    };
    const sub = BackHandler.addEventListener("hardwareBackPress", onBack);
    return () => sub.remove();
  }, [counting, pairing, rec.isRecording, selected]);

  const stopAndSave = async () => {
    const track = await rec.stop();
    // Don't vanish silently: a run with no usable GPS used to just disappear and
    // dump you back on the list with no explanation.
    if (track.points.length < 2) {
      Alert.alert(
        "Nothing to save",
        "No usable GPS points were recorded — check that location is enabled and you have a clear view of the sky."
      );
      return;
    }
    // Name by date, not `Run ${runs.length+1}` — that collides after any delete.
    track.name = `${sportInfo(track.sport).label} · ${fmtDate(track.points[0]?.t ?? Date.now())}`;
    // Reuse the id minted at record-start so any annotations pinned mid-run attach to
    // this saved run (fallback keeps a legacy path working if runId is ever empty).
    const run = makeRun(track, rec.runId || "run-" + Date.now());
    await saveRun(run);
    setRuns((r) => [run, ...r]);
    setSelected(run);
  };

  // Persist an edited run (name/category) and refresh list + detail.
  const updateRun = async (r: Run) => {
    await saveRun(r);
    setRuns((prev) => prev.map((x) => (x.id === r.id ? r : x)));
    setSelected((cur) => (cur && cur.id === r.id ? r : cur));
  };

  // Deleting is genuinely unrecoverable: there is no history/backfill on the wire
  // (liblogosdelivery exposes no Store query), so an unsynced run exists ONLY
  // here. Say so rather than showing a generic "are you sure?".
  const removeRun = (run: Run) =>
    Alert.alert(
      "Delete run?",
      `${run.name}\n\n${fmtDist(run.summary.distanceM)} · ${fmtDur(run.summary.durationS)}\n\n` +
        "This can't be undone. If you haven't synced or exported it, the run is gone for good.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete", style: "destructive",
          onPress: async () => {
            await deleteRun(run.id);
            setRuns((r) => r.filter((x) => x.id !== run.id));
            if (selected?.id === run.id) setSelected(null);
          },
        },
      ]
    );

  // ---- pairing view (overlays everything; reachable from header + deep link) ----
  if (pairing) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <View style={styles.header}>
          <Text style={styles.title}>Pairing</Text>
          <Pressable onPress={() => setPairing(false)} hitSlop={12}>
            <Text style={styles.back}>‹ Back</Text>
          </Pressable>
        </View>
        <PairingScreen
          initialUri={pairUri}
          onClose={() => setPairing(false)}
          onChange={setPaired}
        />
      </SafeAreaView>
    );
  }

  // ---- recording view ----
  if (rec.isRecording) {
    const s = rec.liveStats;
    const foot = sportInfo(rec.sport).foot;
    // Live analytics over the run-so-far: same fold as the saved run, so splits
    // and elevation on this page match the detail page exactly. computeSummary/
    // computeSplits only read points/hasAlt/hasHr, so a synthetic track is fine.
    const hasAlt = rec.points.some((p) => p.alt != null);
    const liveTrack: Track = { points: rec.points, hasAlt, hasHr: false };
    const liveSummary = computeSummary(liveTrack);
    const liveSplits = computeSplits(liveTrack);
    // Follow mode fits the viewport to the last `followM` metres so the map is a
    // zoomed crop tracking you; the full polyline is still drawn on top.
    const followPts = mapFollow ? tailByDistance(rec.points, followM) : undefined;
    const W_ = W();
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="light-content" />
        <View style={styles.header}>
          <Text style={styles.title}>
            {sportInfo(rec.sport).label} · {rec.isPaused ? (rec.isAutoPaused ? "auto-paused" : "paused") : "recording"}
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ paddingBottom: 108 }} showsVerticalScrollIndicator={false}>
        {/* One hero metric + supporting stats — readable in a <1s glance while
            moving, rather than equal-weight tiles. */}
        <View style={styles.heroWrap}>
          <Text style={styles.heroK}>Distance</Text>
          <Text style={[styles.heroV, rec.isPaused && styles.heroVPaused]}>{fmtDist(s.distanceM)}</Text>
        </View>
        {/* Paused is a state you can leave the phone in for minutes — it has to
            be obvious from across a table that nothing is being recorded. */}
        {rec.isPaused && (
          <Text style={styles.pausedNote}>
            {rec.isAutoPaused ? "Auto-paused (stopped) — move to resume" : "Paused — GPS not recording"}
          </Text>
        )}
        <View style={styles.subStats}>
          <View style={styles.subStat}>
            <Text style={styles.tileK}>Time</Text>
            <Text style={styles.subV}>{fmtDur(s.durationS)}</Text>
          </View>
          <View style={styles.subStat}>
            <Text style={styles.tileK}>{rateLabel(foot)}</Text>
            <Text style={styles.subV}>{fmtRate(s.paceSecPerKm, foot)}</Text>
          </View>
          <View style={styles.subStat}>
            <Text style={styles.tileK}>Elev gain</Text>
            <Text style={styles.subV}>{fmtElev(liveSummary.elevGainM)}</Text>
          </View>
        </View>
        <View style={[styles.mapBox, { width: W_, height: 220, marginHorizontal: 16, marginTop: 16 }]}>
          <RouteMap points={rec.points} width={W_} height={220} fitPoints={followPts} />
          {/* Tell the truth about WHY the map is empty. The recorder uses
              distanceInterval: 1, i.e. Android's setSmallestDisplacement(1) — no
              fix is delivered until you move a metre. So standing at the start
              line yields exactly one point and then silence. Saying "waiting for
              GPS" there is a lie: the fix is already in hand, we're waiting for
              movement, and it contradicts the "GPS ready" chip you just saw. */}
          {rec.points.length === 0 && <Text style={styles.mapHint}>Acquiring GPS…</Text>}
          {rec.points.length === 1 && <Text style={styles.mapHint}>GPS locked — start moving</Text>}
        </View>
        {/* Map view controls (issue #1): follow-vs-full and zoom (which shrinks
            the follow crop). Zoom only applies in follow mode. */}
        <View style={styles.mapCtrlRow}>
          <Pressable style={[styles.mapCtrlBtn, mapFollow && styles.mapCtrlBtnOn]} onPress={() => setMapFollow((v) => !v)}>
            <Text style={[styles.mapCtrlText, mapFollow && styles.mapCtrlTextOn]}>{mapFollow ? "◎ Following" : "◍ Full route"}</Text>
          </Pressable>
          {mapFollow && (
            <>
              <Pressable style={styles.mapZoomBtn} onPress={() => setFollowM((m) => Math.min(1500, Math.round(m * 1.6)))}>
                <Text style={styles.mapZoomText}>–</Text>
              </Pressable>
              <Pressable style={styles.mapZoomBtn} onPress={() => setFollowM((m) => Math.max(50, Math.round(m / 1.6)))}>
                <Text style={styles.mapZoomText}>+</Text>
              </Pressable>
            </>
          )}
        </View>
        {/* Annotate the run live — pinned to your current point, stored on-device. */}
        <QuickAnnotate runId={rec.runId} points={rec.points} />
        {hasAlt && (
          <>
            <Text style={styles.sectionLabel}>ELEVATION · +{fmtElev(liveSummary.elevGainM)}</Text>
            <View style={[styles.mapBox, { width: W_, height: 110, marginHorizontal: 16 }]}>
              <ElevationChart points={rec.points} width={W_} height={110} />
            </View>
          </>
        )}
        {liveSplits.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginTop: 12 }}>
            <Text style={styles.sectionLabel}>SPLITS</Text>
            <SplitsTable splits={liveSplits} foot={foot} width={W_} />
          </View>
        )}
        </ScrollView>
        {/* Pause is the common action mid-run (lights, crossings) and stays a
            single tap. Stop is the irreversible one — the run ends and saves —
            so it requires a deliberate hold. */}
        <View style={styles.ctrlRow}>
          <Pressable
            style={[styles.ctrlBtn, styles.ctrlPrimary,
                    { backgroundColor: rec.isPaused ? theme.primary : theme.card }]}
            onPress={() => (rec.isPaused ? rec.resume() : rec.pause())}
          >
            <Text style={[styles.recordText, { color: rec.isPaused ? "#1a1206" : theme.text }]}>
              {rec.isPaused ? "Resume" : "Pause"}
            </Text>
          </Pressable>
          <HoldButton
            label="Hold to stop"
            holdingLabel="Keep holding…"
            color={theme.error}
            onComplete={stopAndSave}
          />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>Perun</Text>
        <View style={styles.headerRight}>
          {selected && (
            <Pressable onPress={() => setSelected(null)} hitSlop={12}>
              <Text style={styles.back}>‹ Runs</Text>
            </Pressable>
          )}
          <Pressable onPress={openPairing} hitSlop={12} style={styles.pairBtn}>
            <View style={[styles.pairDot, { backgroundColor: paired ? theme.success : theme.textTertiary }]} />
            <Text style={styles.pairText}>{paired ? "Paired" : "Pair"}</Text>
          </Pressable>
        </View>
      </View>

      <SharedNodeStatus appName="Perun" showSync style={{ marginHorizontal: 16 }} />

      {selected ? (
        <Detail run={selected} onChange={updateRun} paired={!!paired} onNeedPairing={openPairing} onDelete={removeRun} />
      ) : (
        <SectionList
          sections={groupByWeek(runs)}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 128 }}
          SectionSeparatorComponent={() => <View style={{ height: 10 }} />}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          stickySectionHeadersEnabled={false}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {rec.permissionDenied ? "Location permission denied — enable it to record runs." : "No runs yet — tap Record run"}
            </Text>
          }
          /* Weekly totals: "have I done enough this week?" is the question a
             flat reverse-chronological list cannot answer. */
          renderSectionHeader={({ section }) => (
            <View style={styles.weekHead}>
              <Text style={styles.weekTitle}>{section.title}</Text>
              <Text style={styles.weekTotals}>
                {fmtDist(section.distanceM)}  ·  {fmtDur(section.durationS)}  ·  {section.data.length}{" "}
                {section.data.length === 1 ? "run" : "runs"}
              </Text>
            </View>
          )}
          renderItem={({ item }) => (
            <Pressable style={styles.rowCard} onPress={() => setSelected(item)} onLongPress={() => removeRun(item)}>
              <View style={{ flex: 1 }}>
                <View style={styles.rowTop}>
                  <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
                  {!!item.category && (
                    <View style={styles.rowTag}><Text style={styles.rowTagText}>{item.category}</Text></View>
                  )}
                </View>
                {/* Date was stored but never shown — a list of auto-named runs
                    was unidentifiable without it. */}
                <Text style={styles.rowSub}>
                  {fmtDate(item.startTs)}  ·  {fmtDist(item.summary.distanceM)}  ·  {fmtDur(item.summary.durationS)}
                </Text>
              </View>
              <Text style={styles.rowPace}>
                {fmtRate(item.summary.avgPaceSecPerKm, sportInfo(item.sport).foot)}
              </Text>
            </Pressable>
          )}
        />
      )}


      {!selected && (
        <View style={styles.startDock}>
          {/* Sport picked BEFORE start — it sets the GPS outlier gate, so it
              can't be a post-hoc edit like the category is. */}
          <View style={styles.sportRow}>
            {SPORTS.map((sp) => {
              const on = sp.id === sport;
              return (
                <Pressable key={sp.id} onPress={() => setSport(sp.id)} style={[styles.sportChip, on && styles.sportChipOn]}>
                  <Text style={[styles.sportText, on && styles.sportTextOn]}>{sp.label}</Text>
                </Pressable>
              );
            })}
          </View>
          {/* GPS readiness. Starting before the receiver has a lock is how you
              get a junk first fix, so surface it instead of letting people find
              out afterwards. Never blocks starting — treadmill/tunnel starts are
              legitimate and the recorder gates fixes anyway. */}
          <View style={styles.gpsRow}>
            <View style={[styles.gpsDot, { backgroundColor: gps.ready ? theme.success : theme.primary }]} />
            <Text style={styles.gpsText}>
              {gps.accuracyM == null
                ? "Acquiring GPS…"
                : gps.ready
                ? `GPS ready · ±${Math.round(gps.accuracyM)} m`
                : `Weak GPS · ±${Math.round(gps.accuracyM)} m`}
            </Text>
          </View>
          <Pressable style={styles.recordBtnDocked} onPress={() => setCounting(true)}>
            <Text style={styles.recordText}>Record {sportInfo(sport).label.toLowerCase()}</Text>
          </Pressable>
        </View>
      )}

      {counting && (
        <Countdown
          onDone={() => { setCounting(false); rec.start(sport); }}
          onCancel={() => setCounting(false)}
        />
      )}
    </SafeAreaView>
  );
}

function Tile({ k, v }: { k: string; v: string }) {
  return (
    <View>
      <Text style={styles.tileK}>{k}</Text>
      <Text style={styles.tileV}>{v}</Text>
    </View>
  );
}

// Per-km splits table: KM · pace/speed · elevation gain · HR, with a bar scaled
// by pace across the shown splits (fastest = full, slowest = 25%). Shared by the
// run detail and the live recording page (which passes splits of the run so far).
function SplitsTable({ splits, foot, width }: { splits: Split[]; foot: boolean; width: number }) {
  if (!splits.length) return null;
  const paces = splits.map((x) => x.paceSecPerKm).filter((p) => p > 0);
  const fastest = paces.length ? Math.min(...paces) : 0;
  const slowest = paces.length ? Math.max(...paces) : 0;
  const barFor = (pace: number) => {
    const max = Math.max(4, width - 240);
    if (!pace || pace <= 0 || slowest <= 0) return 4;
    if (slowest === fastest) return max;
    const t = (slowest - pace) / (slowest - fastest);
    return Math.max(max * 0.25, max * (0.25 + 0.75 * t));
  };
  return (
    <>
      <View style={styles.splitHead}>
        <Text style={[styles.splitH, { width: 34 }]}>KM</Text>
        <Text style={[styles.splitH, { width: 84 }]}>{foot ? "PACE" : "SPEED"}</Text>
        <Text style={[styles.splitH, { width: 66 }]}>ELEV</Text>
        <Text style={styles.splitH}>HR</Text>
      </View>
      {splits.map((sp) => (
        <View key={sp.index} style={styles.splitRow}>
          <Text style={[styles.splitCell, { width: 34 }]}>{sp.index}</Text>
          <Text style={[styles.splitCell, { width: 84 }]}>{fmtRate(sp.paceSecPerKm, foot)}</Text>
          <Text style={[styles.splitCellSec, { width: 66 }]}>+{fmtElev(sp.elevGainM)}</Text>
          <Text style={[styles.splitCellSec, { width: 40 }]}>{sp.avgHr > 0 ? Math.round(sp.avgHr) : "—"}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, {
              width: barFor(sp.paceSecPerKm),
              backgroundColor: sp.paceSecPerKm === fastest ? theme.success : theme.primary,
            }]} />
          </View>
        </View>
      ))}
    </>
  );
}

function Detail({ run, onChange, paired, onNeedPairing, onDelete }: {
  run: Run; onChange: (r: Run) => void; paired: boolean;
  onNeedPairing: () => void; onDelete: (r: Run) => void;
}) {
  const w = W();
  const s = run.summary;
  const foot = sportInfo(run.sport).foot;
  const tiles: [string, string][] = [
    ["Distance", fmtDist(s.distanceM)],
    ["Time", fmtDur(s.durationS)],
    [foot ? "Avg pace" : "Avg speed", fmtRate(s.avgPaceSecPerKm, foot)],
    ["Elev gain", fmtElev(s.elevGainM)],
    // HR only when there IS heart-rate data. A phone has no HR sensor, so this
    // tile read a permanent "—" on every run it recorded — a slot that can never
    // hold a value is noise. It still shows for an imported Garmin/Strava track.
    ...(s.hasHr ? ([["Avg HR", Math.round(s.avgHr) + " bpm"]] as [string, string][]) : []),
  ];
  // Hide-map (issue #2): drop the OSM basemap before sharing so the route shape,
  // times and elevation stay but the *where* doesn't. Off by default.
  const [hideMap, setHideMap] = useState(false);
  // Annotation pins on the MAIN route map — a switch, on by default when the run
  // has any. Reuses RouteMap's markers; the dedicated composer map lives below.
  const annotations = useAnnotations(run.id);
  const [showPins, setShowPins] = useState(true);
  const mapMarkers = annotations.map((a) => ({ id: a.id, lat: a.lat, lon: a.lon, kind: a.kind }));
  const share = async () => {
    try { await exportRun(run); }
    catch (e) { Alert.alert("Export failed", e instanceof Error ? e.message : String(e)); }
  };
  // Share-as-image: snapshot the card below exactly as rendered (so it honours
  // the Hide-map toggle) and hand the PNG to the OS share sheet.
  const shotRef = useRef<View>(null);
  const [imgBusy, setImgBusy] = useState(false);
  const shareImg = async () => {
    setImgBusy(true);
    try { await shareViewImage(shotRef, run.name); }
    catch (e) { Alert.alert("Image share failed", e instanceof Error ? e.message : String(e)); }
    finally { setImgBusy(false); }
  };
  const [sync, setSync] = useState<string | null>(null);
  const doSync = async () => {
    if (!paired) { onNeedPairing(); return; } // no unpaired plaintext publishing
    setSync("Starting node…");
    try {
      await syncRun(run, setSync);
      setTimeout(() => setSync(null), 4000);
    } catch (e) {
      setSync(null);
      Alert.alert("Sync failed", e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }} keyboardShouldPersistTaps="handled">
      {/* Everything inside this card is what "Share image" snapshots — it
          honours the Hide-map toggle, so a hidden map shares only the shape. */}
      <View ref={shotRef} collapsable={false} style={styles.shotCard}>
        <RunMeta run={run} onChange={onChange} />

        <View style={styles.tiles}>
          {tiles.map(([k, v]) => <Tile key={k} k={k} v={v} />)}
        </View>

        <View style={[styles.mapBox, { width: w, height: 220 }]}>
          <RouteMap
            points={run.track.points}
            width={w}
            height={220}
            hideBasemap={hideMap}
            markers={showPins ? mapMarkers : undefined}
          />
        </View>

        {run.track.points.some((p) => p.alt != null) && (
          <>
            <Text style={styles.sectionLabel}>ELEVATION · +{fmtElev(run.summary.elevGainM)}</Text>
            <View style={[styles.mapBox, { width: w, height: 120 }]}>
              <ElevationChart points={run.track.points} width={w} height={120} />
            </View>
          </>
        )}

        <Text style={styles.sectionLabel}>SPLITS</Text>
        <SplitsTable splits={run.splits} foot={foot} width={w} />

        {/* Watermark so a shared image identifies itself. */}
        <View style={styles.shotFooter}>
          <Text style={styles.shotBrand}>PERUN</Text>
          <Text style={styles.shotDate}>{fmtDate(run.startTs)}</Text>
        </View>
      </View>

      {/* Hide-map controls what BOTH the on-screen map and the shared image
          show, so it sits with the share actions rather than under the map. */}
      <Pressable style={styles.mapToggle} onPress={() => setHideMap((v) => !v)}>
        <Text style={styles.mapToggleText}>{hideMap ? "◻ Show map in image" : "◼ Hide map for sharing (privacy)"}</Text>
      </Pressable>

      {mapMarkers.length > 0 && (
        <Pressable style={styles.mapToggle} onPress={() => setShowPins((v) => !v)}>
          <Text style={styles.mapToggleText}>
            {showPins ? `◉ Annotations on map (${mapMarkers.length})` : "◎ Show annotations on map"}
          </Text>
        </Pressable>
      )}

      <Pressable style={[styles.exportBtn, styles.shareImgBtn]} onPress={shareImg} disabled={imgBusy}>
        <Text style={[styles.exportText, { color: "#1a1206" }]}>{imgBusy ? "Preparing image…" : "Share image"}</Text>
      </Pressable>

      <Pressable style={styles.exportBtn} onPress={share}>
        <Text style={styles.exportText}>Export GPX</Text>
      </Pressable>

      {deliveryAvailable() && (
        <Pressable style={[styles.exportBtn, styles.syncBtn]} onPress={doSync} disabled={!!sync}>
          <Text style={[styles.exportText, { color: "#1a1206" }]}>
            {sync ?? (paired ? "Sync to Basecamp" : "Pair to sync")}
          </Text>
        </Pressable>
      )}

      {/* Journey annotations: pinned notes/photos/voice on this run's route. Lives
          OUTSIDE the shot card so pins + the composer never leak into a shared image. */}
      <RunAnnotations run={run} />

      {/* Delete lived ONLY on a long-press of the list row — a gesture with no
          affordance, so effectively the feature didn't exist. It goes last and
          stays outline-only: discoverable, but not sitting next to Export where
          a mis-tap is expensive. Confirmation is in removeRun(). */}
      <Pressable style={[styles.exportBtn, styles.deleteBtn]} onPress={() => onDelete(run)}>
        <Text style={[styles.exportText, { color: theme.error }]}>Delete run</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg, paddingTop: StatusBar.currentHeight ?? 0 },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  title: { color: theme.text, fontSize: 26, fontWeight: "700" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 16 },
  back: { color: theme.primary, fontSize: 16 },
  pairBtn: { flexDirection: "row", alignItems: "center", gap: 6 },
  pairDot: { width: 8, height: 8, borderRadius: 4 },
  pairText: { color: theme.textSecondary, fontSize: 14, fontWeight: "600" },
  empty: { color: theme.textTertiary, textAlign: "center", marginTop: 60, fontSize: 15, paddingHorizontal: 24 },
  rowCard: { flexDirection: "row", alignItems: "center", backgroundColor: theme.card, borderRadius: 10, padding: 14 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { color: theme.text, fontSize: 16, fontWeight: "600", flexShrink: 1 },
  rowTag: { backgroundColor: theme.elevated, borderWidth: 1, borderColor: theme.border, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  rowTagText: { color: theme.primary, fontSize: 11, fontWeight: "700" },
  rowSub: { color: theme.textSecondary, fontSize: 13, marginTop: 3 },
  rowPace: { color: theme.textSecondary, fontSize: 14 },
  recordBtn: { position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  recordText: { color: "#1a1206", fontSize: 16, fontWeight: "700" },
  // Pause/Stop share the bottom dock. Pause is flex:1.4 so the frequent action
  // is the bigger target.
  ctrlRow: { position: "absolute", left: 16, right: 16, bottom: 24, flexDirection: "row", gap: 10 },
  ctrlBtn: { flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  ctrlPrimary: { flex: 1.4, borderWidth: 1, borderColor: theme.border },
  pausedNote: { color: theme.primary, fontSize: 13, fontWeight: "600", textAlign: "center", marginTop: 2 },
  // Start dock: sport chips sit directly above the Record button.
  startDock: { position: "absolute", left: 16, right: 16, bottom: 24 },
  sportRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 10, justifyContent: "center" },
  sportChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  sportChipOn: { backgroundColor: theme.elevated, borderColor: theme.primary },
  sportText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  sportTextOn: { color: theme.primary },
  recordBtnDocked: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  gpsRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginBottom: 8 },
  gpsDot: { width: 7, height: 7, borderRadius: 4 },
  gpsText: { color: theme.textSecondary, fontSize: 12, fontWeight: "600" },
  weekHead: { paddingTop: 6, paddingBottom: 8 },
  weekTitle: { color: theme.text, fontSize: 15, fontWeight: "700" },
  weekTotals: { color: theme.textTertiary, fontSize: 12, marginTop: 2 },
  // Recording: one hero number + two supporting, glanceable at arm's length.
  heroWrap: { alignItems: "center", marginTop: 8 },
  heroK: { color: theme.textTertiary, fontSize: 12, letterSpacing: 1 },
  heroV: { color: theme.text, fontSize: 68, fontWeight: "800", lineHeight: 76 },
  heroVPaused: { color: theme.textTertiary },
  subStats: { flexDirection: "row", justifyContent: "space-around", marginTop: 4, paddingHorizontal: 24 },
  subStat: { alignItems: "center" },
  subV: { color: theme.text, fontSize: 30, fontWeight: "700", marginTop: 2 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginBottom: 16 },
  tileK: { color: theme.textTertiary, fontSize: 11 },
  tileV: { color: theme.text, fontSize: 17, fontWeight: "600", marginTop: 2 },
  mapBox: { backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  mapHint: { position: "absolute", color: theme.textTertiary, fontSize: 13 },
  splitHead: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  splitH: { color: theme.textTertiary, fontSize: 11 },
  splitRow: { flexDirection: "row", alignItems: "center", height: 30 },
  splitCell: { color: theme.text, fontSize: 13 },
  splitCellSec: { color: theme.textSecondary, fontSize: 13 },
  barTrack: { flex: 1, height: 10, backgroundColor: theme.card, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 10, backgroundColor: theme.primary, borderRadius: 3 },
  // Section headers + map controls (issues #1/#2)
  sectionLabel: { color: theme.textTertiary, fontSize: 11, fontWeight: "700", letterSpacing: 1, marginTop: 16, marginBottom: 8 },
  mapToggle: { alignSelf: "flex-start", marginTop: 8, paddingVertical: 4 },
  mapToggleText: { color: theme.primary, fontSize: 13, fontWeight: "600" },
  mapCtrlRow: { flexDirection: "row", gap: 8, marginTop: 8, paddingHorizontal: 16, alignItems: "center" },
  mapCtrlBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border },
  mapCtrlBtnOn: { backgroundColor: theme.elevated, borderColor: theme.primary },
  mapCtrlText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  mapCtrlTextOn: { color: theme.primary },
  mapZoomBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border, alignItems: "center", justifyContent: "center" },
  mapZoomText: { color: theme.text, fontSize: 20, fontWeight: "700", lineHeight: 22 },
  // Share-as-image card (the captured region) + its watermark
  shotCard: { backgroundColor: theme.bg, paddingTop: 4 },
  shotFooter: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.border },
  shotBrand: { color: theme.primary, fontSize: 14, fontWeight: "800", letterSpacing: 2 },
  shotDate: { color: theme.textTertiary, fontSize: 12 },
  shareImgBtn: { backgroundColor: theme.primary },
  exportBtn: { marginTop: 12, borderWidth: 1, borderColor: theme.border, borderRadius: 12, paddingVertical: 13, alignItems: "center" },
  exportText: { color: theme.text, fontSize: 15, fontWeight: "600" },
  syncBtn: { backgroundColor: theme.primary, borderColor: theme.primary },
  deleteBtn: { marginTop: 20, marginBottom: 8, borderColor: theme.error },
});
