// Persistence for the pairing secret S.
//
// S is the ONLY secret worth protecting (everything else derives from it), so it
// lives in expo-secure-store — Android Keystore-backed, not the plaintext
// AsyncStorage the run store uses. We keep the derived Identity in an in-memory
// cache so hot paths (every sendEnvelope) don't hit the keystore repeatedly.
import * as SecureStore from "expo-secure-store";
import { fromByteArray, toByteArray } from "base64-js";
import { deriveIdentity, Identity } from "./identity";

const SECRET_KEY = "perun.pairing.secret"; // base64 of the 32-byte S

// Cache states: undefined = not loaded yet; null = loaded, unpaired.
let cache: Identity | null | undefined = undefined;

/** The loaded identity, or null if the phone isn't paired. Cached after first read. */
export async function loadIdentity(): Promise<Identity | null> {
  if (cache !== undefined) return cache;
  const stored = await SecureStore.getItemAsync(SECRET_KEY);
  cache = stored ? deriveIdentity(toByteArray(stored)) : null;
  return cache;
}

/** Synchronous peek at the cache — null if unpaired OR not yet loaded. */
export function cachedIdentity(): Identity | null {
  return cache ?? null;
}

/** Persist a new secret to the keystore and return (and cache) its derived identity. */
export async function saveSecret(secret: Uint8Array): Promise<Identity> {
  const id = deriveIdentity(secret); // throws if not 32 bytes — validate before persisting
  await SecureStore.setItemAsync(SECRET_KEY, fromByteArray(secret));
  cache = id;
  return id;
}

/** Forget the pairing (unpair). */
export async function clearIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(SECRET_KEY);
  cache = null;
}
