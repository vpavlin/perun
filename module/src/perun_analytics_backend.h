#pragma once

#include <QJsonArray>
#include <QJsonObject>

#include "rep_perun_analytics_source.h"
#include "logos_ui_plugin_context.h"

/**
 * @brief UI backend for Perun Analytics (universal authoring model).
 *
 * Subscribes to a per-owner content topic over the `delivery_module` and turns
 * received RUN_META messages into rows in the run list. `publishSampleRun`
 * sends a synthetic run over the same topic (a stand-in for the mobile app),
 * so two instances demonstrate the Delivery round-trip.
 *
 * Derives `PerunAnalyticsSimpleSource` (generated from the .rep — PROP setters
 * auto-sync to QML) and `LogosUiPluginContext` (gives `onContextReady()` and
 * `modules()`, the typed caller/event API for the declared delivery_module).
 */
class PerunAnalyticsBackend : public PerunAnalyticsSimpleSource,
                              public LogosUiPluginContext {
public:
  // .rep SLOTs — "" on success, else an error description.
  QString publishSampleRun() override;
  QString ingestRun(QString runJson) override;

protected:
  // Fired once the context is wired; schedules the delivery bootstrap.
  void onContextReady() override;

private:
  // Wire delivery events, then createNode + start + subscribe(kTopic).
  void bootstrap();
  // Add a run (by JSON object), de-duped by id, and republish runsJson.
  void ingestRunObject(const QJsonObject &run);
  void publishRuns();

  QJsonArray m_runs;
  bool m_nodeReady = false;

  // The per-owner LIP-23 content topic (fixed for now; owner identity later).
  static const QString kTopic;
};
