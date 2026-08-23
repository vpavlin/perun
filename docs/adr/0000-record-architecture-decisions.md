# 0. Record architecture decisions

- **Status:** accepted
- **Date:** 2026-08-23

## Context

Perun is a local-first GPS activity tracker: runs are recorded and stored on the
phone, then synced peer-to-peer over Logos Delivery to a desktop Basecamp module and
other devices in the same household. A handful of decisions are load-bearing and
non-obvious — how runs travel on the wire, how the GPS filter is gated, and (newest)
how journey annotations and their media are modelled and stored. Much of the prose
lives in [`../wire-contract.md`](../wire-contract.md), [`../pairing-crypto.md`](../pairing-crypto.md)
and [`../native-delivery-integration.md`](../native-delivery-integration.md); these
ADRs pin the *decisions* so a future change can't quietly undo one.

Perun leans on the **loam** family of libraries where it can — the pairing crypto is
loam-sync's household AEAD (domain `perun`), and the sync model is the same
event-log/CRDT shape loam-sync formalizes. These ADRs record what is specific to
**Perun**; the transport and sync-brain mechanics are decided in
[`loam-sync`](https://github.com/vpavlin/loam-sync) and
[`logos-transport`](https://github.com/vpavlin/logos-transport).

## The log

- [0001](0001-journey-annotations-as-an-event-log.md) — Journey annotations are an append-only event log (CRDT), one event per note/edit/delete
- [0002](0002-local-first-content-addressed-blobs.md) — Annotation media is local-first and content-addressed; the server is a swappable replication backend, never the source of truth

## Predating these ADRs

Earlier decisions are recorded as prose, not yet back-filled into ADRs:

- **Runs travel as gzipped-GPX `CHUNK` envelopes with a per-run `rev` (LWW).** See
  [`../wire-contract.md`](../wire-contract.md).
- **The GPS outlier gate is per-sport**, chosen before recording starts. See
  [`../wire-contract.md`](../wire-contract.md) and `mobile/src/lib/types.ts`.
- **Household pairing crypto** = one 32-byte secret → HKDF schedule, deterministic
  id-derived nonce (ADR 0011 in loam-sync). See [`../pairing-crypto.md`](../pairing-crypto.md).
