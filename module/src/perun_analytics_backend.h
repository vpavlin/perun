#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QMap>
#include <QString>

#include "rep_perun_analytics_source.h"
#include "logos_ui_plugin_context.h"

#include "geo.h"
#include "run_analytics.h"
#include "run_store.h"

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

protected:
  void onContextReady() override;

private:
  void bootstrap();
  void openStoreAndLoad();

  // Split gzipped GPX into TRACK_CHUNK messages and send them on kTopic.
  QString sendChunks(const QString &runId, const QByteArray &gz);
  // Reassembled/own gzipped GPX → parse, analyse, persist.
  void ingestGzTrack(const QString &runId, const QByteArray &gz);
  QJsonObject runToJson(const QString &runId, const perun::Track &tr) const;
  void addRun(const QJsonObject &run, const QByteArray &gz);
  void publishRuns();

  QJsonArray m_runs;
  bool m_nodeReady = false;
  perun::RunStore m_store;
  QString m_dataDir;

  // Chunk reassembly buffers, keyed by runId.
  struct ChunkBuf {
    int total = 0;
    QMap<int, QByteArray> parts;
  };
  QMap<QString, ChunkBuf> m_chunks;

  static const QString kTopic;
};
