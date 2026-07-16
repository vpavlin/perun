// Hold-to-confirm button. Used for Stop: a single tap is far too easy to hit by
// accident with a sleeve or a wrist while moving, and an accidental stop mid-run
// is unrecoverable — the run is already saved and the recording is over. Holding
// costs ~700 ms and removes the whole class of mistake.
//
// The fill is not decoration: without progress feedback a hold-button reads as
// broken ("I pressed it and nothing happened").
import React, { useRef, useState } from "react";
import { Animated, Easing, Pressable, StyleSheet, Text, View, ViewStyle } from "react-native";
import { theme } from "../theme";

const HOLD_MS = 700;

export function HoldButton({
  label,
  holdingLabel,
  onComplete,
  color,
  textColor = "#fff",
  style,
}: {
  label: string;
  holdingLabel?: string;
  onComplete: () => void;
  color: string;
  textColor?: string;
  style?: ViewStyle | ViewStyle[];
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);

  const start = () => {
    setHolding(true);
    Animated.timing(progress, {
      toValue: 1,
      duration: HOLD_MS,
      easing: Easing.linear,
      // width can't use the native driver.
      useNativeDriver: false,
    }).start(({ finished }) => {
      if (!finished) return;
      setHolding(false);
      progress.setValue(0);
      onComplete();
    });
  };

  const cancel = () => {
    setHolding(false);
    Animated.timing(progress, { toValue: 0, duration: 120, useNativeDriver: false }).start();
  };

  return (
    <Pressable
      onPressIn={start}
      onPressOut={cancel}
      style={[styles.btn, { backgroundColor: theme.card, borderColor: color }, style]}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          styles.fill,
          {
            backgroundColor: color,
            width: progress.interpolate({ inputRange: [0, 1], outputRange: ["0%", "100%"] }),
          },
        ]}
      />
      <Text style={[styles.text, { color: holding ? textColor : color }]}>
        {holding ? holdingLabel ?? label : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: {
    flex: 1, borderRadius: 14, paddingVertical: 15, alignItems: "center",
    justifyContent: "center", borderWidth: 1, overflow: "hidden",
  },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0 },
  text: { fontSize: 16, fontWeight: "700" },
});
