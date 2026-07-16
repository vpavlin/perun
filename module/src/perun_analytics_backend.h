#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
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
 * Runs sync over the `delivery_module` as **gzipped GPX**, split into
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
  // Reassembled/own gzipped GPX → parse, analyse, persist (at revision rev).
  void ingestGzTrack(const QString &runId, int rev, const QByteArray &gz);
  QJsonObject runToJson(const QString &runId, int rev, const perun::Track &tr) const;
  // Insert or (last-write-wins by rev) replace a run.
  void addRun(const QJsonObject &run, const QByteArray &gz);
  void publishRuns();

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
  // Filesystem dir the QML sandbox can read tiles from (the plugin's qml dir).
  // Empty until the view calls setTileRoot(); tiles cached under <root>/tiles.
  QString m_tileRoot;

  // Chunk reassembly buffers, keyed by runId.
  struct ChunkBuf {
    int total = 0;
    QMap<int, QByteArray> parts;
  };
  QMap<QString, ChunkBuf> m_chunks;
};
