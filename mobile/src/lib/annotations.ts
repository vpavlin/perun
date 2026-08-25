// Journey annotations — text/photo/voice notes pinned to a point on a recorded run.
//
// Wire contract (shared with the desktop, keep EXACT):
//   { v:1, type:"ANNOTATION", a:{ id, runId, lat, lon, ele, t, createdAt, author,
//                                 kind:"text"|"photo"|"voice"|"delete",
//                                 text?, blobId?, mime?, dur?, target? } }
// Dedup by a.id (like CHUNK). kind:"delete" is an append-only tombstone that removes
// a.target from the displayed set. Photos/voice ride the sealed blob store (blob.ts);
// only this small metadata syncs over Delivery.
//
// Offline-first: an authored annotation is ALWAYS persisted locally first (so it shows
// even with no network / no pairing), then best-effort sent. Unsent ones carry a local
// `synced:false` flag and are retried whenever the receiver comes up (resendUnsynced).
import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import { GeoPoint, Run } from "./types";
import { sendAnnotation, syncRun } from "./runSync";
import { ensureNode, onMessage, getDeviceId, deliveryAvailable, currentFingerprint } from "./delivery";
import { loadIdentity } from "./identityStore";
import { replicatePending, replicateBlob } from "./blob";
import { catchupLadder, onSyncReq } from "./catchup";

export type AnnotationKind = "text" | "photo" | "voice" | "delete" | "edit";

/** The wire `a` object — exactly the shared contract's fields, nothing more. */
export interface Annotation {
  id: string;
  runId: string;
  lat: number;
  lon: number;
  ele: number | null;
  t: number; // epoch ms of the journey point
  createdAt: number; // epoch ms authored
  author: string; // deviceId / addr
  kind: AnnotationKind;
  text?: string; // comment, or caption for photo/voice
  blobId?: string; // photo/voice only, 64-hex sha256
  mime?: string; // original content-type, photo/voice only
  dur?: number; // voice length seconds
  target?: string; // kind:"delete" → the annotation id it tombstones
}

// Stored copy = the wire annotation plus a local-only sync flag (never sent).
interface StoredAnnotation extends Annotation {
  synced?: boolean;
}

const key = (runId: string) => `perun:ann:${runId}`;

// ---- change notifications (ingest / author → UI reloads) --------------------
type ChangeCb = (runId: string) => void;
const changeListeners = new Set<ChangeCb>();
function notifyChange(runId: string) {
  changeListeners.forEach((cb) => {
    try {
      cb(runId);
    } catch {
      /* ignore */
    }
  });
}
export function onAnnotationsChanged(cb: ChangeCb): () => void {
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

// ---- persistence ------------------------------------------------------------
async function readRaw(runId: string): Promise<StoredAnnotation[]> {
  try {
    const raw = await AsyncStorage.getItem(key(runId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is StoredAnnotation => x && typeof x.id === "string");
  } catch {
    return [];
  }
}
async function writeRaw(runId: string, list: StoredAnnotation[]): Promise<void> {
  await AsyncStorage.setItem(key(runId), JSON.stringify(list));
}

/** Strip the local-only field so we only ever persist/emit the wire shape. */
function toWire(a: StoredAnnotation): Annotation {
  const { synced, ...wire } = a;
  return wire;
}

/** Insert one annotation (dedup by id). `synced` marks whether it's already on the wire. */
async function insert(a: Annotation, synced: boolean): Promise<boolean> {
  const list = await readRaw(a.runId);
  const existing = list.findIndex((x) => x.id === a.id);
  if (existing >= 0) {
    // Already have it. Only upgrade the synced flag (true wins) — content is immutable.
    if (synced && !list[existing].synced) {
      list[existing].synced = true;
      await writeRaw(a.runId, list);
    }
    return false;
  }
  list.push({ ...a, synced });
  await writeRaw(a.runId, list);
  notifyChange(a.runId);
  return true;
}

// ---- display ----------------------------------------------------------------
/**
 * Fold the raw event log into the displayed annotations: apply delete tombstones and
 * apply the winning `edit` (last-write-wins by createdAt) over each target's text, then
 * drop the delete/edit events themselves and sort chronologically by t. Order-independent
 * (an edit or delete may arrive before its target). Named applyTombstones for history.
 */
export function applyTombstones(list: Annotation[]): Annotation[] {
  const deleted = new Set<string>();
  const edits = new Map<string, Annotation>(); // target -> winning edit (latest createdAt)
  for (const a of list) {
    if (a.kind === "delete" && a.target) deleted.add(a.target);
    else if (a.kind === "edit" && a.target) {
      const cur = edits.get(a.target);
      if (!cur || a.createdAt > cur.createdAt) edits.set(a.target, a);
    }
  }
  return list
    .filter((a) => a.kind !== "delete" && a.kind !== "edit" && !deleted.has(a.id))
    .map((a) => {
      const ed = edits.get(a.id);
      return ed ? { ...a, text: ed.text } : a; // edit supersedes the caption/body text
    })
    .sort((x, y) => x.t - y.t || x.createdAt - y.createdAt);
}

/** The displayed annotations for a run (tombstones applied). */
export async function loadAnnotations(runId: string): Promise<Annotation[]> {
  return applyTombstones((await readRaw(runId)).map(toWire));
}

// ---- authoring --------------------------------------------------------------
/** RFC-4122-ish v4 uuid from the platform CSPRNG (expo-crypto). */
function uuid(): string {
  const b = Crypto.getRandomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h: string[] = [];
  for (let i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}

export interface NewAnnotation {
  runId: string;
  point: GeoPoint; // the journey point this annotation pins to
  kind: AnnotationKind;
  text?: string;
  blobId?: string;
  mime?: string;
  dur?: number;
  target?: string;
}

/**
 * Author an annotation: persist locally (offline-first), then best-effort send it on
 * the run's sealed channel. Never throws for a send failure — the note is safe locally
 * and retried later (resendUnsynced). Returns the stored Annotation.
 */
export async function authorAnnotation(input: NewAnnotation): Promise<Annotation> {
  const author = await getDeviceId().catch(() => "perun-unknown");
  const a: Annotation = {
    id: uuid(),
    runId: input.runId,
    lat: input.point.lat,
    lon: input.point.lon,
    ele: input.point.alt ?? null,
    t: input.point.t,
    createdAt: Date.now(),
    author,
    kind: input.kind,
  };
  if (input.text != null && input.text !== "") a.text = input.text;
  if (input.blobId) a.blobId = input.blobId;
  if (input.mime) a.mime = input.mime;
  if (input.dur != null) a.dur = input.dur;
  if (input.target) a.target = input.target;

  let sent = false;
  try {
    await sendAnnotation(a);
    sent = true;
  } catch {
    /* offline / unpaired — kept locally, resent later */
  }
  await insert(a, sent);
  return a;
}

/**
 * Edit an annotation's text/caption in place — an append-only supersede event
 * (kind:"edit", target=a.id) that the fold applies LWW over the original. Works for a
 * text note's body and for a photo/voice caption ("add a text note to the photo").
 */
export async function editAnnotation(a: Annotation, newText: string): Promise<void> {
  await authorAnnotation({
    runId: a.runId,
    point: { lat: a.lat, lon: a.lon, alt: a.ele ?? undefined, t: a.t },
    kind: "edit",
    target: a.id,
    text: newText,
  });
}

/** Tombstone an annotation you authored (append-only kind:"delete"). */
export async function deleteAnnotation(a: Annotation): Promise<void> {
  await authorAnnotation({
    runId: a.runId,
    point: { lat: a.lat, lon: a.lon, alt: a.ele ?? undefined, t: a.t },
    kind: "delete",
    target: a.id,
  });
}

// ---- receive / sync ---------------------------------------------------------
/** True for a well-formed ANNOTATION envelope's `a` payload. */
function validAnnotation(a: unknown): a is Annotation {
  const o = a as Partial<Annotation> | null;
  return !!o && typeof o.id === "string" && typeof o.runId === "string" &&
    typeof o.t === "number" && typeof o.kind === "string";
}

/** Re-send every locally-authored annotation that never made it onto the wire. */
export async function resendUnsynced(): Promise<void> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return;
  }
  for (const k of keys) {
    if (!k.startsWith("perun:ann:")) continue;
    const runId = k.slice("perun:ann:".length);
    const list = await readRaw(runId);
    let changed = false;
    for (const a of list) {
      if (a.synced) continue;
      try {
        await sendAnnotation(toWire(a));
        a.synced = true;
        changed = true;
      } catch {
        break; // node down — stop, try again next time
      }
    }
    if (changed) await writeRaw(runId, list);
  }
}

/**
 * Full, NARRATED sync of one run: the GPX route, then every journey annotation
 * (idempotent re-send — the receiver dedups by id), then a sealed copy of each
 * photo/voice blob to the media server. Reports detailed progress through onStatus
 * so sync is never an opaque "synced" again — including the household FINGERPRINT
 * (a key mismatch is the classic silent failure) and per-item counts + errors.
 */
export async function syncRunFull(run: Run, onStatus?: (s: string) => void): Promise<void> {
  // 1. Route (brings the node up; reports "Route: sending N chunks…").
  await syncRun(run, onStatus);
  const fp = currentFingerprint();
  if (fp) onStatus?.(`Paired as “${fp}” — sending annotations…`);

  // 2. Annotations: send EVERY event for this run (text/photo/voice/edit/delete),
  //    idempotent by id, and mark them synced. Collect the media blobs to push.
  const list = await readRaw(run.id);
  const blobs = new Map<string, string>(); // blobId -> mime (dedup)
  let notes = 0, notesFail = 0;
  for (const a of list) {
    if (a.blobId && a.mime) blobs.set(a.blobId, a.mime);
    try {
      await sendAnnotation(toWire(a));
      a.synced = true;
      notes++;
      onStatus?.(`Annotations: ${notes}/${list.length} sent…`);
    } catch {
      notesFail++; // node hiccup — leave unsynced, resendUnsynced retries later
    }
  }
  if (list.length) await writeRaw(run.id, list);

  // 3. Media: push a sealed copy of each referenced blob to the server.
  let media = 0, mediaFail = 0;
  if (blobs.size) {
    let i = 0;
    for (const [cid, mime] of blobs) {
      i++;
      onStatus?.(`Media: uploading ${i}/${blobs.size}…`);
      try {
        (await replicateBlob(cid, mime)) ? media++ : mediaFail++;
      } catch {
        mediaFail++;
      }
    }
  }

  // 4. One honest summary line.
  const parts = [
    "run",
    `${notes} note${notes === 1 ? "" : "s"}${notesFail ? ` (${notesFail} failed)` : ""}`,
  ];
  if (blobs.size) parts.push(`${media} media${mediaFail ? ` (${mediaFail} failed)` : ""}`);
  const bad = notesFail + mediaFail;
  onStatus?.(`${bad ? "Synced with issues" : "Synced ✓"} — ${parts.join(" · ")}${fp ? ` · ${fp}` : ""}`);
  catchupLadder(); // also RBSR-reconcile so we pull anything peers have that we lack
}

/**
 * Start ingesting ANNOTATION envelopes: bring the node up, subscribe, store incoming
 * annotations (dedup by id, tombstones applied on read), and flush any unsent ones.
 * No-op / resolves quietly if delivery isn't available or the phone isn't paired.
 * Returns an unsubscribe function.
 */
export async function startAnnotationReceive(): Promise<() => void> {
  if (!deliveryAvailable()) return () => {};
  if (!(await loadIdentity())) return () => {}; // unpaired: nothing to seal/open with

  const off = onMessage((env) => {
    const e = env as { v?: unknown; type?: unknown; a?: unknown; msg?: unknown };
    if (e.type === "SYNC_REQ") {
      void onSyncReq(e.msg); // RBSR: serve what the peer lacks / pull what we lack
      return;
    }
    if (e.type !== "ANNOTATION" || !validAnnotation(e.a)) return;
    // Received from the wire ⇒ already synced.
    void insert(e.a, true);
  });

  try {
    await ensureNode();
    void resendUnsynced();
    void replicatePending(); // push any on-device blobs the server doesn't have yet
    catchupLadder();         // RBSR: reconcile the annotation log with peers (0/3/10/25s)
  } catch {
    /* node couldn't start — the listener stays registered for when it does */
  }
  return off;
}

// ---- React hook -------------------------------------------------------------
/** Live displayed annotations for a run; reloads on any local change (author/ingest). */
export function useAnnotations(runId: string | null): Annotation[] {
  const [items, setItems] = useState<Annotation[]>([]);
  useEffect(() => {
    if (!runId) {
      setItems([]);
      return;
    }
    let alive = true;
    const reload = () => {
      loadAnnotations(runId).then((a) => {
        if (alive) setItems(a);
      });
    };
    reload();
    const off = onAnnotationsChanged((changed) => {
      if (changed === runId) reload();
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId]);
  return items;
}
