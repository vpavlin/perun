// App settings that aren't the pairing secret. Kept in expo-secure-store to match
// how Perun already persists preferences (see "perun-shared-node" in delivery.ts /
// PairingScreen.tsx) — one small string per key, Keystore-backed. None of these are
// secrets that MUST be protected (the blob token is a soft one), but reusing the same
// store keeps the settings surface in one place instead of split across two backends.
import * as SecureStore from "expo-secure-store";

// SecureStore keys must be alphanumeric + ".-_"; keep the "perun-" prefix used already.
const K_AUTO_PAUSE = "perun-auto-pause"; // "1"/"0", default ON
const K_BLOB_URL = "perun-blob-url"; // e.g. https://blobs.example:8090
const K_BLOB_TOKEN = "perun-blob-token"; // optional bearer for POST /blob

/** Auto-pause the recorder when you stop moving. Default ON. */
export async function getAutoPause(): Promise<boolean> {
  try {
    const v = await SecureStore.getItemAsync(K_AUTO_PAUSE);
    return v == null ? true : v === "1"; // unset ⇒ default ON
  } catch {
    return true;
  }
}
export async function setAutoPause(on: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(K_AUTO_PAUSE, on ? "1" : "0");
  } catch {
    /* best-effort */
  }
}

export interface BlobServer {
  /** Base URL, no trailing slash. Empty = not configured (text notes still work). */
  url: string;
  /** Optional bearer token required by the server for uploads. */
  token: string;
}

/** The configured blob server for photo/voice attachments. url:"" = none. */
export async function getBlobServer(): Promise<BlobServer> {
  try {
    const url = ((await SecureStore.getItemAsync(K_BLOB_URL)) ?? "").trim().replace(/\/+$/, "");
    const token = ((await SecureStore.getItemAsync(K_BLOB_TOKEN)) ?? "").trim();
    return { url, token };
  } catch {
    return { url: "", token: "" };
  }
}

export async function setBlobServer(url: string, token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(K_BLOB_URL, url.trim().replace(/\/+$/, ""));
    await SecureStore.setItemAsync(K_BLOB_TOKEN, token.trim());
  } catch {
    /* best-effort */
  }
}
