#pragma once

#include <QJsonArray>
#include <QJsonObject>

#include "rep_perun_analytics_source.h"
#include "logos_ui_plugin_context.h"

#include "track_codec.h"
#include "run_analytics.h"
#include "run_store.h"

/**
 * @brief UI backend for Perun Analytics (universal authoring model).
 *
 * Subscribes to a per-owner content topic over the `delivery_module`. Each run
 * arrives as a JSON envelope carrying a base64 compact track blob; the backend
 * decodes the track (track_codec.h) and computes summary + per-km splits
 * (run_analytics.h) — the "detailed analytics" the module adds on top of the
 * raw points. `publishSampleRun` generates a synthetic track and sends it the
 * same way (a stand-in for the mobile app).
 */
class PerunAnalyticsBackend : public PerunAnalyticsSimpleSource,
                              public LogosUiPluginContext {
public:
  // .rep SLOTs — "" on success, else an error description.
  QString publishSampleRun() override;
  QString ingestRun(QString runJson) override;

protected:
  void onContextReady() override;

private:
  void bootstrap();
  // Open the local SQLite store and load any previously-saved runs.
  void openStoreAndLoad();

  // Decode + analyse a received/own run, then add it (de-duped by id).
  void ingestTrackRun(const QJsonObject &meta, const perun::Track &tr);
  // Build the rich run JSON (id/name/startTs + summary + splits) for the view.
  QJsonObject runToJson(const QJsonObject &meta, const perun::Track &tr) const;
  void addRun(const QJsonObject &run);
  void publishRuns();

  QJsonArray m_runs;
  bool m_nodeReady = false;
  perun::RunStore m_store;

  static const QString kTopic;
};
