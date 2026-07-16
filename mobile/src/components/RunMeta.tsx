// Editable run name + category. Both are written to the Run AND its Track,
// because the Track is what gets serialized to GPX — so a rename/recategorize
// flows out through Sync (Delivery) and Export GPX, and survives Strava/Garmin.
import React, { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";
import { Run, CATEGORIES } from "../lib/types";
import { theme } from "../theme";

/** Apply name/category to a Run and keep its Track (the GPX source) in sync.
 *  Bumps rev so a re-sync REPLACES the desktop copy instead of being deduped. */
export function withMeta(run: Run, m: { name?: string; category?: string }): Run {
  const name = m.name ?? run.name;
  const category = m.category !== undefined ? m.category : run.category;
  return {
    ...run,
    name,
    category,
    rev: (run.rev ?? 1) + 1,
    // category rides a perun: GPX extension; <type> carries the sport, which is
    // fixed at record time and must not be clobbered by a metadata edit.
    track: { ...run.track, name, category },
  };
}

const isPreset = (c?: string) => !!c && (CATEGORIES as readonly string[]).includes(c);

export function RunMeta({ run, onChange }: { run: Run; onChange: (r: Run) => void }) {
  const [name, setName] = useState(run.name);
  const [customOn, setCustomOn] = useState(!!run.category && !isPreset(run.category));
  const [custom, setCustom] = useState(isPreset(run.category) ? "" : run.category ?? "");

  const commitName = () => {
    const n = name.trim();
    if (!n || n === run.name) { setName(run.name); return; }
    onChange(withMeta(run, { name: n }));
  };

  const pickPreset = (c: string) => {
    setCustomOn(false);
    onChange(withMeta(run, { category: run.category === c ? undefined : c }));
  };

  const commitCustom = () => {
    const c = custom.trim();
    onChange(withMeta(run, { category: c || undefined }));
  };

  return (
    <View style={styles.wrap}>
      <TextInput
        style={styles.name}
        value={name}
        onChangeText={setName}
        onEndEditing={commitName}
        onSubmitEditing={commitName}
        returnKeyType="done"
        selectTextOnFocus
        placeholder="Name this run"
        placeholderTextColor={theme.textTertiary}
      />

      <View style={styles.chips}>
        {CATEGORIES.map((c) => {
          const on = run.category === c;
          return (
            <Pressable key={c} onPress={() => pickPreset(c)} style={[styles.chip, on && styles.chipOn]}>
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{c}</Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => setCustomOn((v) => !v)}
          style={[styles.chip, customOn && styles.chipOn]}
        >
          <Text style={[styles.chipText, customOn && styles.chipTextOn]}>
            {customOn ? "Custom" : "Custom…"}
          </Text>
        </Pressable>
      </View>

      {customOn && (
        <TextInput
          style={styles.custom}
          value={custom}
          onChangeText={setCustom}
          onEndEditing={commitCustom}
          onSubmitEditing={commitCustom}
          returnKeyType="done"
          autoFocus={!run.category}
          placeholder="e.g. hill reps, commute, parkrun"
          placeholderTextColor={theme.textTertiary}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 16 },
  name: {
    color: theme.text, fontSize: 20, fontWeight: "700", padding: 0, marginBottom: 12,
    borderBottomWidth: 1, borderBottomColor: theme.border, paddingBottom: 6,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: theme.card, borderWidth: 1, borderColor: theme.border,
  },
  chipOn: { backgroundColor: theme.primary, borderColor: theme.primary },
  chipText: { color: theme.textSecondary, fontSize: 13, fontWeight: "600" },
  chipTextOn: { color: "#1a1206" },
  custom: {
    marginTop: 10, color: theme.text, fontSize: 14, backgroundColor: theme.card,
    borderWidth: 1, borderColor: theme.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 9,
  },
});
