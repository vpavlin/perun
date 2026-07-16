// Local persistence for recorded runs.
//
// Storage choice: @react-native-async-storage/async-storage (not expo-sqlite).
// Rationale: the app keeps a modest number of runs and simply needs to store /
// load whole Run objects (including the full track) as JSON. AsyncStorage is a
// dead-simple async key/value store that covers exactly that with no schema,
// migrations, or query layer. We avoid its main pitfall — rewriting one giant
// blob on every save — by giving each run its OWN key (`run:<id>`) plus a small
// index of ids. So saving/deleting one run only touches that run + the index,
// which stays cheap even with 1200-point tracks. expo-sqlite would only pay off
// if we needed relational queries or thousands of large rows, which we don't.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Run } from './types';

// Key layout:
//   perun:run:index  -> JSON string[] of run ids
//   perun:run:<id>   -> JSON Run object (full, including track)
const INDEX_KEY = 'perun:run:index';
const runKey = (id: string) => `perun:run:${id}`;

/** Read the id index, tolerating missing / corrupt data. */
async function readIndex(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // keep only well-formed string ids, de-duped
    return Array.from(new Set(parsed.filter((x): x is string => typeof x === 'string')));
  } catch {
    return [];
  }
}

async function writeIndex(ids: string[]): Promise<void> {
  const unique = Array.from(new Set(ids));
  await AsyncStorage.setItem(INDEX_KEY, JSON.stringify(unique));
}

/**
 * Persist a run. De-dupes by id: saving a run whose id already exists overwrites
 * the stored copy and does not add a duplicate to the index.
 */
export async function saveRun(run: Run): Promise<void> {
  if (!run || typeof run.id !== 'string' || run.id.length === 0) {
    throw new Error('saveRun: run.id is required');
  }
  // Write the run object first, then register it in the index. If the index
  // write fails, a stray run blob is harmless (loadRuns is index-driven).
  await AsyncStorage.setItem(runKey(run.id), JSON.stringify(run));
  const ids = await readIndex();
  if (!ids.includes(run.id)) {
    ids.push(run.id);
    await writeIndex(ids);
  }
}

/**
 * Load all runs, newest first (by startTs desc). Never throws: corrupt or
 * missing entries are skipped, and any unexpected failure yields [].
 */
export async function loadRuns(): Promise<Run[]> {
  try {
    const ids = await readIndex();
    if (ids.length === 0) return [];

    const keys = ids.map(runKey);
    const pairs = await AsyncStorage.multiGet(keys);

    const runs: Run[] = [];
    for (const [, raw] of pairs) {
      if (!raw) continue; // index referenced a missing run — skip
      try {
        const run = JSON.parse(raw) as Run;
        if (run && typeof run.id === 'string') runs.push(run);
      } catch {
        // corrupt individual entry — skip it, keep the rest
      }
    }

    runs.sort((a, b) => (b.startTs ?? 0) - (a.startTs ?? 0));
    return runs;
  } catch {
    return [];
  }
}

/** Delete one run by id (both its blob and its index entry). Idempotent. */
export async function deleteRun(id: string): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) return;
  await AsyncStorage.removeItem(runKey(id));
  const ids = await readIndex();
  const next = ids.filter((x) => x !== id);
  if (next.length !== ids.length) {
    await writeIndex(next);
  }
}

/** Remove every run and the index. */
export async function clearAll(): Promise<void> {
  try {
    const ids = await readIndex();
    const keys = [...ids.map(runKey), INDEX_KEY];
    await AsyncStorage.multiRemove(keys);
  } catch {
    // last resort: at least drop the index so loadRuns() returns []
    try {
      await AsyncStorage.removeItem(INDEX_KEY);
    } catch {
      /* give up silently */
    }
  }
}
