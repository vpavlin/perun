#pragma once

#include <QJsonArray>

#include "rep_perun_analytics_source.h"
#include "logos_ui_plugin_context.h"

/**
 * @brief UI backend for Perun Analytics (universal authoring model).
 *
 * You write only this class and the `.rep` view contract; the `*Plugin` /
 * `*Interface` glue (Q_PLUGIN_METADATA, initLogos, QtRO registration) is
 * generated around it. It derives:
 *   - `PerunAnalyticsSimpleSource` — generated from perun_analytics.rep;
 *     implement its slots and feed its PROPs (setStatus/setReady/setRunsJson),
 *     which auto-sync to every QML replica.
 *   - `LogosUiPluginContext` — gives `onContextReady()` and `modules()` (the
 *     typed callers/event subscriptions for declared dependencies; none yet —
 *     `delivery_module` lands next iteration).
 *
 * This iteration is Delivery-free: runs are injected via the `ingestRun` test
 * hook so the UI + build path can be exercised end-to-end. The message-receive
 * path over `delivery_module` replaces that hook next.
 */
class PerunAnalyticsBackend : public PerunAnalyticsSimpleSource,
                              public LogosUiPluginContext {
public:
  // .rep SLOT — ingest one run summary as JSON. "" on success, else an error.
  QString ingestRun(QString runJson) override;

protected:
  // Fired once the context is wired; marks the backend ready.
  void onContextReady() override;

private:
  // Accumulated run summaries; serialized into the runsJson PROP for the view.
  QJsonArray m_runs;
  void publishRuns();
};
