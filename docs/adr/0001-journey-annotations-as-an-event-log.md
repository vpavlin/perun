# 1. Journey annotations are an append-only event log (CRDT)

- **Status:** accepted
- **Date:** 2026-08-23

## Context

A journey annotation is a note pinned to a point on a run: a text comment, a photo, or
a voice memo. Several devices in one household may add annotations to the same run,
online or offline, and must converge without a coordinator and without losing writes —
the same problem runs themselves have, and the same problem loam-sync exists to solve.

A run is not one mutable document with an "annotations" array: two phones editing that
array offline is a classic lost-update. We want each annotation to be an independent,
immutable fact that merges commutatively, so order of arrival and connectivity don't
change the result.

## Decision

Model annotations as an **append-only event log**, one event per annotation, edit, or
delete — the loam-sync event-log/CRDT shape. Each event is a self-contained
`ANNOTATION` envelope carried over Delivery exactly like a run `CHUNK` (sealed with the
household key, AAD = topic):

```
{ v:1, type:"ANNOTATION", a:{
    id, runId, lat, lon, ele, t, createdAt, author,
    kind:"text"|"photo"|"voice"|"delete"|"edit",
    text?, blobId?, mime?, dur?, target?
}}
```

- **Immutable + content-keyed by `a.id`.** Receiving the same `id` twice is a no-op
  (dedup) — so re-sending is safe and idempotent, which is how offline notes flush.
- **Edit = a new event** (`kind:"edit"`, `target` = the id it supersedes, carrying the
  new `text`). The fold applies the winning edit — last-write-wins by `createdAt` — over
  the target's caption/body; the edit events themselves aren't displayed. Order-independent
  (an edit may arrive before its target). This is how a note's text is changed and how a
  caption is added to a photo/voice, without ever mutating the original event.
- **Delete = a tombstone** (`kind:"delete"`, `target` = the id it removes). Append-only:
  a delete can't be un-seen, and it commutes with a late-arriving original.
- **Deterministic display fold.** `applyTombstones` drops tombstoned ids and the
  tombstones themselves, then sorts by `t` (journey time), tie-broken by `createdAt`.
  Any device folding the same set of events shows the same list.
- **Offline-first authoring.** An authored event is persisted locally FIRST
  (`AsyncStorage: perun:ann:<runId>`, a per-run log) and only then best-effort sent; a
  local `synced:false` flag drives `resendUnsynced` when the receiver comes up. The note
  is never lost to a failed send, and never waits on the network to appear in the UI.

Media bytes do **not** travel in the event — the event carries a `blobId` (a content id;
see [ADR 0002](0002-local-first-content-addressed-blobs.md)); only this small metadata
syncs over Delivery.

## Rejected

- **A mutable per-run annotations array.** Lost-update under offline multi-writer — the
  exact failure the event log avoids.
- **Hard delete (drop the event).** Not commutative: an original arriving after the
  delete would resurrect. A tombstone is order-independent.
- **Importing loam-sync's full Clock/RBSR reconcile now.** The current lightweight
  per-run log + `resendUnsynced` is enough for the shipped feature. Aligning the fold
  with loam-sync's HLC + range-based reconciliation is the natural next step and is what
  buys **cold-start backfill** (a brand-new device pulling annotations authored before it
  joined) — see Consequences.

## Consequences

- Annotations converge across devices with no central authority; re-sync is idempotent.
- Like runs, there is **no cold-start history sync**: Delivery exposes no Store query, so
  a device only receives annotations authored while it is subscribed (plus local
  re-sends). A brand-new device does not backfill a run's older annotations. Closing this
  means adopting loam-sync's reconcile (RBSR) — tracked, not done.
- The wire event is stable and shared with the desktop module; changing `a`'s shape is a
  wire-compat change and must land on both platforms together.
