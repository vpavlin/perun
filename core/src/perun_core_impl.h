#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QSet>
#include <QString>
#include <string>

#include <map>
#include <memory>

#include "logos_module_context.h"

#include "geo.h"
#include "perun_identity.h"
#include "run_analytics.h"
#include "run_store.h"
#include "logos_sync/event.hpp"    // Event, HLC, Clock, mergeEvents
#include "logos_sync/catchup.hpp"  // RBSR buildInitial() / respond()

class QNetworkAccessManager;
class QTimer;
class PerunBlobServer;

/**
 * @brief Perun headless engine + sync core (universal authoring model).
 *
 * This is the whole Perun engine with NO QML/view: pairing/identity, the
 * `loam_core` Delivery transport, the run + annotation event-log fold, the
 * SQLite store and the embedded content-addressed media hub. It runs identically
 * in Basecamp (behind the `perun_analytics` view) and headless in a `logoscore`
 * daemon (the always-on hub) — see docs/adr/0006.
 *
 * Runs sync over `loam_core` as **gzipped GPX**, split into CHUNK messages when
 * over the Waku budget; on receipt it reassembles + gunzips + parses + computes
 * summary/splits (run_analytics.h) and persists both (run_store.h). Annotations
 * (photo/voice/text/edit/delete) are a separate append-only event-log folded here.
 *
 * Universal authoring: the public methods below ARE the module API (each returns
 * a JSON-serializable std::string), and the module-builder generates both the
 * plugin glue and the typed `modules().perun_core.*` proxy the view calls.
 */
class PerunCoreImpl : public LogosModuleContext {
public:
  // ---- API (universal; JSON-string in/out) ----

  // One JSON blob the view polls each refresh (charter: O(1) IPC per refresh):
  // { status, ready, fingerprint, pairingUri, runs:[…], annotations:{…},
  //   blobServer, blobServerUrl }. `runs`/`annotations` are the folded state.
  std::string snapshot();

  // Decoded track points for a run: JSON [{lat,lon,alt,altValid,hr,t,brk}, …].
  std::string trackJson(std::string runId);

  // Publish a synthetic run (gzipped GPX, chunked) over Delivery — stand-in for
  // the mobile app. "" on success, else an error string.
  std::string publishSampleRun();

  // Write a run out as a .gpx; returns the file path ("" on error).
  std::string exportGpx(std::string runId);

  // Set + persist the media replication backend (url + optional bearer token).
  // Pass "" token to leave it unset. Returns "".
  std::string configureBlobServer(std::string url, std::string token);

  // Fetch + decrypt one media blob (photo/voice). Returns the PLAINTEXT bytes as
  // base64 ("" if unavailable). Local-first: served from the embedded hub's sealed
  // store with no network if we hold it; else a blocking GET from the configured
  // blob server. The view writes the bytes into its own sandbox for display.
  std::string getMedia(std::string blobId, std::string mime);

  // Author a text annotation. `json` = {runId, lat, lon, ele?, eleValid, t, text}.
  // Seals an ANNOTATION{kind:"text"} envelope, sends it, applies locally. "" ok.
  std::string addAnnotation(std::string json);

  // Generate a NEW pairing secret (unpairs every currently-paired phone) and
  // resubscribe to the new derived topic. "" on success.
  std::string resetPairing();

  // Adopt an EXISTING household from a `perun://pair?s=<code>` deep link (or a bare
  // code): persist the decoded secret, re-derive identity+topic, resubscribe. Lets a
  // hub join the same household as a phone/desktop without a rebuild. "" on success.
  std::string pairWithCode(std::string code);

  // Convenience scalars (snapshot() carries these too).
  std::string status();
  std::string fingerprint();

  // Passthrough of the delivery node metrics (peers/mesh/shard) for debugging.
  std::string metricsJson();

logos_events:
  // Emitted for event-capable hosts when the folded state changes / the node
  // status moves. The desktop view POLLS snapshot() and does not rely on these
  // (desktop event delivery is unreliable — kym/scala finding); a headless host
  // with EMIT_FROM_THREAD=1 does receive them.
  void statusChanged(const std::string &status);
  void runsChanged(const std::string &runsJson);
  void annotationsChanged(const std::string &annotationsJson);

protected:
  void onContextReady() override;

private:
  void bootstrap();
  void openStoreAndLoad();
  // If the (stable) data dir has no runs yet, adopt a legacy perun store found on
  // disk (old ui_qml module's AppDataLocation etc.) so an update/split never loses
  // the user's runs or their pairing. Runs are local data, independent of the key.
  void migrateLegacyDataIfEmpty();
  void loadOrCreateSecret();
  void applyIdentity(const perun::Bytes &secret);

  // Split gzipped GPX into encrypted CHUNK messages, sent on the derived topic.
  QString sendChunks(const QString &runId, int rev, const QByteArray &gz);
  // Recover a sealed CHUNK/ANNOTATION envelope (any base64 depth), reassemble+ingest.
  void ingestSealed(const QByteArray &raw);
  void ingestGzTrack(const QString &runId, int rev, const QByteArray &gz);
  QJsonObject runToJson(const QString &runId, int rev, const perun::Track &tr) const;
  void addRun(const QJsonObject &run, const QByteArray &gz);

  // ---- Annotations (append-only event-log fold) ----
  bool applyAnnotation(const QJsonObject &a, bool persist);
  void applyEditToTarget(const QString &runId, const QString &target);
  void loadAnnotations();

  // ---- loam-sync RBSR catch-up (docs/adr/0001; scala's pattern) ----
  // Each annotation is a logos_sync::Event (id=a.id, hlc from createdAt, payload=a).
  // We keep the annotation WIRE unchanged and add only a SYNC_REQ control frame that
  // carries catchup fp/ids/need messages, so a cold / rejoined / restarted peer
  // reconciles the annotation log by set-difference instead of relying on push.
  void trackAnnEvent(const QJsonObject &a);        // add/refresh the raw event for RBSR
  std::vector<logos_sync::Event> annEventsVec() const;
  void sendSyncReq();                              // publish buildInitial() over the topic
  void onSyncReq(const nlohmann::json &msg);       // respond(): serve + reply
  void catchupLadder();                            // 0/3/10/25s re-publish after Connected

  // ---- Embedded media hub ----
  void startBlobServer();
  QString blobStoreDir() const;
  void loadBlobConfig();
  // Blocking GET <blobServer>/blob/<blobId>, return the sealed ciphertext bytes
  // ("" on error). Decryption is the caller's (getMedia opens with our identity).
  QByteArray fetchSealedBlob(const QString &blobId);

  // ---- Hub mode ----
  // With PERUN_HUB set: a self-driven QTimer (headless has no view to pump the
  // bootstrap/heartbeat) that re-attempts bring-up until ready and writes a
  // <dataDir>/hub.json heartbeat (status/ready/peers/logLen/fingerprint).
  void startHubTimer();
  void writeHubHeartbeat();

  // ---- State ----
  QString m_status = QStringLiteral("Starting…");
  bool m_ready = false;
  QString m_fingerprintStr;
  QString m_pairingUri;

  QJsonArray m_runs;
  bool m_nodeReady = false;
  perun::RunStore m_store;
  QString m_dataDir;
  QString m_deviceId;
  bool m_hub = false;

  // Pairing identity: the shared secret derives our content topic + payload key.
  perun::Identity m_id;
  QString m_topic;

  QNetworkAccessManager *m_net = nullptr;      // lazily created; unparented
  PerunBlobServer *m_blobServer = nullptr;     // embedded media hub (parent null)
  QString m_blobServerUrl;                     // this instance's hub URL (surfaced)
  QTimer *m_hubTimer = nullptr;
  // loam_core.metricsJson is async on the core proxy; the periodic poll caches
  // the latest here so the synchronous metricsJson()/hub heartbeat can read it.
  QString m_lastMetrics;

  // Chunk reassembly buffers, keyed by runId@rev.
  struct ChunkBuf {
    int total = 0;
    QMap<int, QByteArray> parts;
  };
  QMap<QString, ChunkBuf> m_chunks;

  // Annotations: runId -> (id -> `a`), per-run tombstones, per-run winning edits.
  QMap<QString, QMap<QString, QJsonObject>> m_annotations;
  QMap<QString, QSet<QString>> m_annDeleted;
  QMap<QString, QMap<QString, QJsonObject>> m_annEdits;

  // RBSR: the RAW annotation event log (EVERY event incl edit/delete), keyed by id.
  // Reconciled by set-difference; the fold above derives the display state from it.
  std::map<std::string, logos_sync::Event> m_annRaw;
  std::unique_ptr<logos_sync::Clock> m_clock; // HLC stamper, primed from m_annRaw

  // Media replication backend (empty = unconfigured). Token = upload-only.
  QString m_blobUrl;
  QString m_blobToken;

  // Helpers to fold-then-emit.
  void publishRuns();
  void publishAnnotations();
  void setStatusStr(const QString &s);
};
