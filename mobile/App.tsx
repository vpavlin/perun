import React, { useState } from "react";
import {
  SafeAreaView, View, Text, Pressable, FlatList, ScrollView,
  StyleSheet, StatusBar, Dimensions,
} from "react-native";
import { Run, Track } from "./src/lib/types";
import { computeSummary, computeSplits, fmtDist, fmtPace, fmtDur, fmtElev } from "./src/lib/analytics";
import { synthRun } from "./src/lib/synth";
import { RouteMap } from "./src/components/RouteMap";
import { theme } from "./src/theme";

function makeRun(track: Track): Run {
  return {
    id: "run-" + Date.now(),
    name: track.name || "Run",
    startTs: track.points[0]?.t ?? Date.now(),
    summary: computeSummary(track),
    splits: computeSplits(track),
    track,
  };
}

export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<Run | null>(null);

  const record = () => {
    const n = runs.length + 1;
    const track = synthRun(1200, 1);
    track.name = `Morning run ${n}`;
    const run = makeRun(track);
    setRuns((r) => [run, ...r]);
    setSelected(run);
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={styles.header}>
        <Text style={styles.title}>Perun</Text>
        {selected && (
          <Pressable onPress={() => setSelected(null)} hitSlop={12}>
            <Text style={styles.back}>‹ Runs</Text>
          </Pressable>
        )}
      </View>

      {selected ? (
        <Detail run={selected} />
      ) : (
        <FlatList
          data={runs}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 16, paddingBottom: 96 }}
          ItemSeparatorComponent={() => <View style={{ height: 10 }} />}
          ListEmptyComponent={<Text style={styles.empty}>No runs yet — tap Record run</Text>}
          renderItem={({ item }) => (
            <Pressable style={styles.rowCard} onPress={() => setSelected(item)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName}>{item.name}</Text>
                <Text style={styles.rowSub}>
                  {fmtDist(item.summary.distanceM)}  ·  {fmtDur(item.summary.durationS)}
                </Text>
              </View>
              <Text style={styles.rowPace}>{fmtPace(item.summary.avgPaceSecPerKm)}</Text>
            </Pressable>
          )}
        />
      )}

      {!selected && (
        <Pressable style={styles.recordBtn} onPress={record}>
          <Text style={styles.recordText}>Record run</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

function Detail({ run }: { run: Run }) {
  const w = Dimensions.get("window").width - 32;
  const s = run.summary;
  const tiles: [string, string][] = [
    ["Distance", fmtDist(s.distanceM)],
    ["Time", fmtDur(s.durationS)],
    ["Avg pace", fmtPace(s.avgPaceSecPerKm)],
    ["Elev gain", fmtElev(s.elevGainM)],
    ["Avg HR", s.hasHr ? Math.round(s.avgHr) + " bpm" : "—"],
  ];
  return (
    <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 32 }}>
      <Text style={styles.detailName}>{run.name}</Text>

      <View style={styles.tiles}>
        {tiles.map(([k, v]) => (
          <View key={k} style={styles.tile}>
            <Text style={styles.tileK}>{k}</Text>
            <Text style={styles.tileV}>{v}</Text>
          </View>
        ))}
      </View>

      <View style={[styles.mapBox, { width: w, height: 220 }]}>
        <RouteMap points={run.track.points} width={w} height={220} />
      </View>

      <View style={styles.splitHead}>
        <Text style={[styles.splitH, { width: 34 }]}>KM</Text>
        <Text style={[styles.splitH, { width: 84 }]}>PACE</Text>
        <Text style={[styles.splitH, { width: 66 }]}>ELEV</Text>
        <Text style={styles.splitH}>HR</Text>
      </View>
      {run.splits.map((sp) => (
        <View key={sp.index} style={styles.splitRow}>
          <Text style={[styles.splitCell, { width: 34 }]}>{sp.index}</Text>
          <Text style={[styles.splitCell, { width: 84 }]}>{fmtPace(sp.paceSecPerKm)}</Text>
          <Text style={[styles.splitCellSec, { width: 66 }]}>+{fmtElev(sp.elevGainM)}</Text>
          <Text style={[styles.splitCellSec, { width: 40 }]}>{sp.avgHr > 0 ? Math.round(sp.avgHr) : "—"}</Text>
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: Math.max(4, (w - 240) * Math.min(1, sp.distanceM / 1000)) }]} />
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  title: { color: theme.text, fontSize: 26, fontWeight: "700" },
  back: { color: theme.primary, fontSize: 16 },
  empty: { color: theme.textTertiary, textAlign: "center", marginTop: 60, fontSize: 15 },
  rowCard: { flexDirection: "row", alignItems: "center", backgroundColor: theme.card, borderRadius: 10, padding: 14 },
  rowName: { color: theme.text, fontSize: 16, fontWeight: "600" },
  rowSub: { color: theme.textSecondary, fontSize: 13, marginTop: 3 },
  rowPace: { color: theme.textSecondary, fontSize: 14 },
  recordBtn: { position: "absolute", left: 16, right: 16, bottom: 24, backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center" },
  recordText: { color: "#1a1206", fontSize: 16, fontWeight: "700" },
  detailName: { color: theme.text, fontSize: 20, fontWeight: "700", marginBottom: 14 },
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 18, marginBottom: 16 },
  tile: {},
  tileK: { color: theme.textTertiary, fontSize: 11 },
  tileV: { color: theme.text, fontSize: 17, fontWeight: "600", marginTop: 2 },
  mapBox: { backgroundColor: theme.elevated, borderRadius: 10, borderWidth: 1, borderColor: theme.border, overflow: "hidden", marginBottom: 16 },
  splitHead: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  splitH: { color: theme.textTertiary, fontSize: 11 },
  splitRow: { flexDirection: "row", alignItems: "center", height: 30 },
  splitCell: { color: theme.text, fontSize: 13 },
  splitCellSec: { color: theme.textSecondary, fontSize: 13 },
  barTrack: { flex: 1, height: 10, backgroundColor: theme.card, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 10, backgroundColor: theme.primary, borderRadius: 3 },
});
