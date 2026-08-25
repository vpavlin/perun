// loam-sync RBSR catch-up for Perun's annotation log (mirrors perun_core's C++;
// docs/adr/0001). The annotation WIRE is unchanged — we add only a SYNC_REQ control
// frame carrying catchup fp/ids/need messages, so a cold / rejoined / restarted peer
// reconciles the whole annotation log by set-difference instead of relying on live push.
//
// perun/mobile is the first TS consumer of loam-sync's catchup — it imports the
// vendored dist (src/lib/loam-sync) directly; buildInitial/respond are byte-parity
// with the C++ header the hub/desktop run.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { buildInitial, respond } from "./loam-sync/catchup.js";
import type { CatchupMsg } from "./loam-sync/catchup";
import type { Event } from "./loam-sync/event";
import { sendEnvelope, getDeviceId } from "./delivery";

// The RAW annotation event log across ALL runs (every kind incl edit/delete), each
// wrapped as a loam-sync Event keyed by a.id, ordered by createdAt. RBSR diffs this
// set; the app's fold (applyTombstones) derives the displayed state from it.
async function annEvents(): Promise<Event[]> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return [];
  }
  const out: Event[] = [];
  for (const k of keys) {
    if (!k.startsWith("perun:ann:")) continue;
    let raw: string | null;
    try {
      raw = await AsyncStorage.getItem(k);
    } catch {
      continue;
    }
    if (!raw) continue;
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const a of list as Array<Record<string, unknown>>) {
      if (!a || typeof a.id !== "string") continue;
      const wall =
        typeof a.createdAt === "number" ? a.createdAt : typeof a.t === "number" ? a.t : 0;
      const dev = typeof a.author === "string" ? a.author : "";
      out.push({ v: 1, id: a.id, type: "ANNOTATION", hlc: { wall, ctr: 0, dev }, dev, payload: a });
    }
  }
  return out;
}

/** Publish our annotation-log fingerprint; peers (esp. the hub) serve what we lack. */
export async function sendSyncReq(): Promise<void> {
  const from = await getDeviceId();
  const msg = buildInitial(await annEvents(), from);
  await sendEnvelope({ v: 1, type: "SYNC_REQ", msg });
}

/** Respond to an incoming fp/ids/need: serve annotations the peer lacks + range replies. */
export async function onSyncReq(msg: unknown): Promise<void> {
  if (!msg || typeof msg !== "object") return;
  const me = await getDeviceId();
  const step = respond(await annEvents(), msg as CatchupMsg, me);
  for (const e of step.serve) {
    // serve over the normal ANNOTATION wire (deterministic seal → dedups on the receiver)
    await sendEnvelope({ v: 1, type: "ANNOTATION", a: (e as Event).payload });
  }
  for (const r of step.replies) {
    await sendEnvelope({ v: 1, type: "SYNC_REQ", msg: r });
  }
}

/**
 * Re-publish our fingerprint at 0/3/10/25s — the shared node's mesh takes ~10s to
 * form and a single early request is lost (scala's ladder, loam-sync ADR 0004).
 */
export function catchupLadder(): void {
  const go = () => {
    void sendSyncReq().catch(() => {});
  };
  go();
  for (const ms of [3000, 10000, 25000]) setTimeout(go, ms);
}
