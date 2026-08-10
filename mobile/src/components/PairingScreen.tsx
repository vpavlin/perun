// Pairing UI: scan the QR the desktop Basecamp shows (perun://pair?s=<base32>),
// or paste the link / bare code, then confirm the 3-word fingerprint matches.
// The scanned/typed secret is persisted to the Keystore (identityStore) and all
// sync from then on is encrypted+topic-scoped to this pairing.
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View, Text, Pressable, TextInput, ScrollView, StyleSheet, ActivityIndicator, Alert, Switch,
} from "react-native";
import * as SecureStore from "expo-secure-store";
import { CameraView, useCameraPermissions, BarcodeScanningResult } from "expo-camera";
import { Identity, secretFromScan } from "../lib/identity";
import { loadIdentity, saveSecret, clearIdentity } from "../lib/identityStore";
import { theme } from "../theme";

export function PairingScreen({
  initialUri,
  onClose,
  onChange,
}: {
  initialUri?: string | null; // a perun://pair?s=… link from a deep link, prefills
  onClose: () => void;
  onChange?: (id: Identity | null) => void; // notify App so the header updates
}) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const busy = useRef(false); // debounce rapid duplicate barcode callbacks

  // Delivery backend: Perun's own embedded node, or the device-wide Logos Delivery node.
  // Read at node bring-up (delivery.ts); needs a restart to take effect.
  const [sharedNode, setSharedNode] = useState(false);
  useEffect(() => { SecureStore.getItemAsync("perun-shared-node").then((v) => setSharedNode(v === "1")).catch(() => {}); }, []);
  const setSharedNodePref = (v: boolean) => { setSharedNode(v); SecureStore.setItemAsync("perun-shared-node", v ? "1" : "0").catch(() => {}); };

  // Apply a scanned/typed string: parse → persist → show fingerprint.
  const apply = useCallback(
    async (text: string) => {
      if (busy.current) return;
      busy.current = true;
      try {
        const secret = secretFromScan(text);
        const id = await saveSecret(secret);
        setIdentity(id);
        setScanning(false);
        setManual("");
        setError(null);
        onChange?.(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        busy.current = false;
      }
    },
    [onChange],
  );

  // Initial load: read the current pairing, then prefill from a deep link if unpaired.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await loadIdentity();
      if (cancelled) return;
      setIdentity(id);
      setLoading(false);
      if (!id && initialUri) apply(initialUri);
    })();
    return () => { cancelled = true; };
  }, [initialUri, apply]);

  const onScanned = (r: BarcodeScanningResult) => { if (scanning) apply(r.data); };

  const startScan = async () => {
    setError(null);
    const perm = permission?.granted ? permission : await requestPermission();
    if (perm?.granted) setScanning(true);
  };

  const unpair = () =>
    Alert.alert("Unpair?", "This phone will stop syncing until you pair again.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Unpair", style: "destructive",
        onPress: async () => {
          await clearIdentity();
          setIdentity(null);
          onChange?.(null);
        },
      },
    ]);

  if (loading) {
    return (
      <View style={[styles.root, styles.center]}>
        <ActivityIndicator color={theme.primary} />
      </View>
    );
  }

  // ---- Live scanner ----
  if (scanning) {
    return (
      <View style={styles.root}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
          onBarcodeScanned={onScanned}
        />
        <View style={styles.scanOverlay}>
          <Text style={styles.scanHint}>Point at the QR your Basecamp shows</Text>
          <Pressable style={styles.ghostBtn} onPress={() => setScanning(false)}>
            <Text style={styles.ghostText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  // ---- Paired: show fingerprint + re-pair / unpair ----
  if (identity) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Text style={styles.h1}>Paired</Text>
        <Text style={styles.body}>Confirm these 3 words match what your Basecamp shows.</Text>
        <Fingerprint words={identity.fingerprint} />

        <View style={styles.nodeCard}>
          <View style={styles.nodeHeader}>
            <Text style={styles.nodeLabel}>Shared Logos Delivery node</Text>
            <Switch
              value={sharedNode}
              onValueChange={setSharedNodePref}
              trackColor={{ true: theme.primary, false: theme.border }}
              thumbColor="#fff"
            />
          </View>
          <Text style={styles.nodeNote}>
            {sharedNode
              ? "Sync runs through the Logos Delivery app's one device-wide node — install it and approve Perun once. Keeps syncing when Perun is backgrounded. Restart Perun to apply."
              : "Perun runs its own embedded node (default). Restart Perun to apply a change."}
          </Text>
        </View>

        <Pressable style={styles.primaryBtn} onPress={onClose}>
          <Text style={styles.primaryText}>Done</Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} onPress={startScan}>
          <Text style={styles.ghostText}>Re-pair (scan a new code)</Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} onPress={unpair}>
          <Text style={[styles.ghostText, { color: theme.error }]}>Unpair</Text>
        </Pressable>
      </ScrollView>
    );
  }

  // ---- Unpaired: scan or manual entry ----
  const denied = permission && !permission.granted && !permission.canAskAgain;
  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.h1}>Pair with Basecamp</Text>
      <Text style={styles.body}>
        Scan the QR code your desktop Basecamp shows, or paste the pairing link below.
      </Text>

      {!denied ? (
        <Pressable style={styles.primaryBtn} onPress={startScan}>
          <Text style={styles.primaryText}>Scan QR code</Text>
        </Pressable>
      ) : (
        <Text style={[styles.body, { color: theme.error }]}>
          Camera permission denied — enable it in Settings, or paste the link below.
        </Text>
      )}

      <Text style={styles.label}>Or paste a link / code</Text>
      <TextInput
        style={styles.input}
        placeholder="perun://pair?s=…"
        placeholderTextColor={theme.textTertiary}
        autoCapitalize="none"
        autoCorrect={false}
        value={manual}
        onChangeText={setManual}
      />
      <Pressable
        style={[styles.primaryBtn, !manual.trim() && styles.btnDisabled]}
        disabled={!manual.trim()}
        onPress={() => apply(manual.trim())}
      >
        <Text style={styles.primaryText}>Pair</Text>
      </Pressable>

      {!!error && <Text style={styles.error}>{error}</Text>}

      <Pressable style={styles.ghostBtn} onPress={onClose}>
        <Text style={styles.ghostText}>Cancel</Text>
      </Pressable>
    </ScrollView>
  );
}

function Fingerprint({ words }: { words: string[] }) {
  return (
    <View style={styles.fpBox}>
      {words.map((w, i) => (
        <Text key={i} style={styles.fpWord}>{w}</Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.bg },
  center: { alignItems: "center", justifyContent: "center" },
  content: { padding: 20, paddingBottom: 40 },
  h1: { color: theme.text, fontSize: 24, fontWeight: "700", marginBottom: 8 },
  body: { color: theme.textSecondary, fontSize: 15, lineHeight: 21, marginBottom: 20 },
  label: { color: theme.textTertiary, fontSize: 12, marginTop: 24, marginBottom: 8, textTransform: "uppercase" },
  input: {
    backgroundColor: theme.card, borderRadius: 10, borderWidth: 1, borderColor: theme.border,
    color: theme.text, fontSize: 15, paddingHorizontal: 14, paddingVertical: 12,
  },
  primaryBtn: { backgroundColor: theme.primary, borderRadius: 14, paddingVertical: 15, alignItems: "center", marginTop: 16 },
  primaryText: { color: "#1a1206", fontSize: 16, fontWeight: "700" },
  btnDisabled: { opacity: 0.4 },
  ghostBtn: { paddingVertical: 14, alignItems: "center", marginTop: 4 },
  ghostText: { color: theme.primary, fontSize: 15, fontWeight: "600" },
  error: { color: theme.error, fontSize: 14, marginTop: 14, textAlign: "center" },
  nodeCard: { backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border, padding: 14, marginTop: 20 },
  nodeHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  nodeLabel: { color: theme.text, fontSize: 15, fontWeight: "600", flex: 1, paddingRight: 10 },
  nodeNote: { color: theme.textSecondary, fontSize: 13, lineHeight: 18, marginTop: 8 },
  fpBox: {
    flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10,
    backgroundColor: theme.card, borderRadius: 12, borderWidth: 1, borderColor: theme.border,
    padding: 20, marginBottom: 8,
  },
  fpWord: { color: theme.primary, fontSize: 22, fontWeight: "700" },
  scanOverlay: { position: "absolute", left: 0, right: 0, bottom: 40, alignItems: "center", paddingHorizontal: 20 },
  scanHint: {
    color: "#fff", fontSize: 15, backgroundColor: "rgba(0,0,0,0.6)",
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, marginBottom: 12, overflow: "hidden",
  },
});
