// Publish a recorded run to the desktop Basecamp module over Logos Delivery.
//
// Wire format = gzipped GPX, split into CHUNK envelopes — byte-for-byte the same
// contract the desktop perun_analytics module sends/receives (see the module's
// sendChunks / bootstrap messageReceived handler):
//   envelope = { v:1, type:"CHUNK", id, seq, total, gz:<base64 of a gz slice> }
// The desktop reassembles parts[0..total-1], gunzips, parses the GPX, and stores
// the run. Re-syncing the same id is idempotent there (dedupe by id).
// NOTE: named import, not default. pako's `exports` map sends ESM consumers to
// dist/pako.mjs, which has NO default export — `import pako from "pako"` is
// undefined at runtime (only bites in the bundle, not in tsc).
import { gzip } from "pako";
import { fromByteArray } from "base64-js";
import { toGpx } from "./gpx";
import { ensureNode, sendEnvelope } from "./delivery";
import { Run } from "./types";

// Raw gz bytes per chunk. Kept well under Waku's 150 KB wire budget once
// base64-expanded (~1.33x). Chunk size need not match the desktop's — the
// receiver reassembles purely by seq/total.
const CHUNK_BYTES = 60000;

export interface SyncProgress {
  (status: string): void;
}

/**
 * Gzip the run's GPX, split into chunks, and publish each on the Perun topic.
 * Resolves once every chunk has been sent (the desktop ingests asynchronously).
 */
export async function syncRun(run: Run, onStatus?: SyncProgress): Promise<void> {
  await ensureNode(onStatus);

  const gpx = toGpx(run.track);
  const gz = gzip(gpx); // Uint8Array
  const total = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));

  // rev lets the desktop replace an existing run (edited name/category) instead
  // of dropping the re-send as a duplicate. Monotonic; bumped on every edit.
  const rev = run.rev ?? 1;
  for (let seq = 0; seq < total; seq++) {
    const part = gz.subarray(seq * CHUNK_BYTES, (seq + 1) * CHUNK_BYTES);
    const env = {
      v: 3,
      type: "CHUNK",
      id: run.id,
      rev,
      seq,
      total,
      gz: fromByteArray(part),
    };
    onStatus?.(total > 1 ? `Sending chunk ${seq + 1}/${total}…` : "Sending…");
    await sendEnvelope(env);
  }

  onStatus?.("Synced ✓");
}
