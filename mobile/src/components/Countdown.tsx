// 3·2·1 countdown before recording starts.
//
// Two real jobs beyond feeling nice: it gives you a moment to put the phone away
// / get to the start line so the first metres aren't you standing still fumbling,
// and it's a cancel window for a mis-tap. Recording begins only when it reaches
// GO, so nothing is recorded if you back out.
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";

const FROM = 3;

export function Countdown({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [n, setN] = useState(FROM);

  useEffect(() => {
    if (n <= 0) { onDone(); return; }
    const id = setTimeout(() => setN((v) => v - 1), 800);
    return () => clearTimeout(id);
  }, [n, onDone]);

  return (
    <View style={styles.wrap}>
      <Text style={styles.n}>{n > 0 ? n : "GO"}</Text>
      <Pressable onPress={onCancel} hitSlop={16} style={styles.cancel}>
        <Text style={styles.cancelText}>Cancel</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: theme.bg, alignItems: "center", justifyContent: "center", zIndex: 10,
  },
  n: { color: theme.primary, fontSize: 120, fontWeight: "800" },
  cancel: { marginTop: 32, paddingHorizontal: 24, paddingVertical: 10, borderRadius: 999, borderWidth: 1, borderColor: theme.border },
  cancelText: { color: theme.textSecondary, fontSize: 15, fontWeight: "600" },
});
