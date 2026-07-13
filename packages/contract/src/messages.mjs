// Perun Delivery message envelope (LIP-23 topics: /perun/1/<runId>/proto).
// Payload passed to delivery_module.send() is these bytes; the module base64-wraps
// them across the FFI, so effective Waku budget is ~150 KB * 3/4 of RAW bytes.

export const TYPES = { RUN_META: 1, TRACK_CHUNK: 2, LIVE_POINT: 3, DELETE: 4 };

export const topics = {
  run: (runId) => `/perun/1/${runId}/proto`,
  pairing: () => `/perun/1/pairing/proto`,
};

// Waku hard cap; base64 inflates raw by 4/3, so keep RAW chunks under this budget.
export const WAKU_MAX_BYTES = 150_000;
export const RAW_CHUNK_BUDGET = Math.floor(WAKU_MAX_BYTES * 3 / 4) - 512; // headroom for envelope

export const base64Len = (rawBytes) => Math.ceil(rawBytes / 3) * 4;

// Envelope is intentionally small; the heavy field is the (encrypted) track blob.
// { v:1, type, runId, sender, ts, seq?, total?, sig, blob }
export function estimateEnvelopeOverhead() {
  // runId(16) + sender(32) + sig(64) + type/seq/total/ts (~20) + framing (~16) ~= 148 bytes
  return 148;
}
