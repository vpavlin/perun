#pragma once

#include <QByteArray>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QSet>
#include <QString>

#include "rep_perun_analytics_source.h"
#include "logos_ui_plugin_context.h"

#include "geo.h"
#include "perun_identity.h"
#include "run_analytics.h"
#include "run_store.h"

class QNetworkAccessManager;

/**
 * @brief UI backend for Perun Analytics (universal authoring model).
 *
 * Runs sync over the `loam_core` transport facade as **gzipped GPX**, split into
 * TRACK_CHUNK messages when over the Waku budget. On receipt the backend
 * reassembles the chunks, gunzips, parses the GPX, computes summary + per-km
 * splits (run_analytics.h) and persists both the computed run and the gzipped
 * GPX (run_store.h) — the GPX is the source of truth for the route map and for
 * export/interop with Garmin/Strava. `publishSampleRun` generates a synthetic
 * run and sends it the same way (a stand-in for the mobile app).
 */
class PerunAnalyticsBackend : public PerunAnalyticsSimpleSource,
                              public LogosUiPluginContext {
public:
  // .rep SLOTs.
  QString publishSampleRun() override;
  QString trackJson(QString runId) override;
  QString exportGpx(QString runId) override;
  // Point the tile cache at a sandbox-readable dir (the plugin's qml dir).
  QString setTileRoot(QString dirUrl) override;
  // OSM raster basemap: cache tile z/x/y under the tile root and return its
  // file:// URL (or "" on failure). See perun_analytics.rep.
  QString ensureTile(int z, int x, int y) override;
  // Regenerate the pairing secret + resubscribe to the new derived topic.
  QString resetPairing() override;
  // In-process QR encode (vendored qrcodegen) → JSON matrix for the QML.
  QString qrMatrix(QString text) override;

  // Set + persist the blob-server URL (+ optional bearer token) for media fetch.
  QString configureBlobServer(QString url, QString token) override;
  // Fetch + decrypt a media blob; returns a file:// URL if cached, else "" and
  // emits mediaReady/mediaFailed. See perun_analytics.rep.
  QString loadMedia(QString blobId, QString mime) override;
  // Author + send a text annotation from the desktop.
  QString addTextAnnotation(QString runId, double lat, double lon, double ele,
                            bool eleValid, double t, QString text) override;

protected:
  void onContextReady() override;

private:
  void bootstrap();
  void openStoreAndLoad();
  // Load the persisted 32-byte pairing secret (or create+persist one), derive
  // the Identity, and publish the fingerprint/pairingUri PROPs. m_dataDir must
  // be set first (openStoreAndLoad).
  void loadOrCreateSecret();
  void applyIdentity(const perun::Bytes &secret);

  // Split gzipped GPX into encrypted CHUNK messages, sent on the derived topic.
  QString sendChunks(const QString &runId, int rev, const QByteArray &gz);
  // Recover a sealed CHUNK envelope (relay or SDS-channel wire, any base64
  // depth), reassemble and ingest.
  void ingestSealed(const QByteArray &raw);
  // Reassembled/own gzipped GPX → parse, analyse, persist (at revision rev).
  void ingestGzTrack(const QString &runId, int rev, const QByteArray &gz);
  QJsonObject runToJson(const QString &runId, int rev, const perun::Track &tr) const;
  // Insert or (last-write-wins by rev) replace a run.
  void addRun(const QJsonObject &run, const QByteArray &gz);
  void publishRuns();

  // ---- Annotations ----
  // Fold one annotation `a` object into the in-memory collection: dedup by a.id,
  // apply kind:"delete" tombstones (order-independent). Persists when persist is
  // true. Returns true if the set changed. Used by both live ingest and load.
  bool applyAnnotation(const QJsonObject &a, bool persist);
  // Apply the winning edit (LWW by createdAt) over a target annotation's text, if present.
  void applyEditToTarget(const QString &runId, const QString &target);
  void loadAnnotations();
  void publishAnnotations();
  void loadBlobConfig();
  // GET <blobServer>/blob/<blobId> async, open() the sealed bytes, cache the
  // plaintext under the sandbox media dir, then emit mediaReady/mediaFailed.
  void fetchAndDecryptBlob(const QString &blobId, const QString &mime);
  // Directory (inside the view sandbox when tileRoot is set) for decrypted media.
  QString mediaDir() const;

  QJsonArray m_runs;
  bool m_nodeReady = false;
  perun::RunStore m_store;
  QString m_dataDir;

  // Pairing identity: the shared secret derives our content topic + payload key.
  // Runs sync on m_topic (the derived, unlinkable topic), encrypted with m_id.
  perun::Identity m_id;
  QString m_topic;

  // Lazily created on the backend thread for OSM tile fetches (ensureTile).
  QNetworkAccessManager *m_net = nullptr;
  // Filesystem dir the QML sandbox can read tiles from (the plugin's qml dir),
  // set by the view via setTileRoot(). Empty until then.
  QString m_tileRoot;

  // Chunk reassembly buffers, keyed by runId.
  struct ChunkBuf {
    int total = 0;
    QMap<int, QByteArray> parts;
  };
  QMap<QString, ChunkBuf> m_chunks;

  // Annotations: runId -> (annotationId -> `a` object), plus per-run tombstones
  // (targets of a kind:"delete") so a delete arriving before its target still
  // suppresses it. Both persisted via RunStore.
  QMap<QString, QMap<QString, QJsonObject>> m_annotations;
  QMap<QString, QSet<QString>> m_annDeleted;
  // runId -> target -> the winning edit event (kind:"edit"), LWW by createdAt. Applied
  // over the target's text; kept so an edit arriving before its target still wins.
  QMap<QString, QMap<QString, QJsonObject>> m_annEdits;

  // Blob server for photo/voice media (empty = unconfigured). Token is upload-
  // only; reads are open, but we send it too if set.
  QString m_blobUrl;
  QString m_blobToken;
  // In-flight media fetches, so a repeated loadMedia doesn't double-GET.
  QSet<QString> m_mediaInFlight;
};
