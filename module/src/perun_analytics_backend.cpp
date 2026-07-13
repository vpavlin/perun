#include "perun_analytics_backend.h"

#include <iostream>

#include <QJsonDocument>
#include <QJsonObject>

// Generated umbrella for typed dependency access (modules()). No dependencies
// declared yet; delivery_module lands next iteration.
// #include "logos_sdk.h"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_analytics backend] " << what << std::endl;
}
} // namespace

void PerunAnalyticsBackend::onContextReady() {
  logEvent("onContextReady — backend ready");
  setStatus(QStringLiteral("Ready — waiting for runs"));
  setReady(true);
}

QString PerunAnalyticsBackend::ingestRun(QString runJson) {
  QJsonParseError err{};
  const QJsonDocument doc = QJsonDocument::fromJson(runJson.toUtf8(), &err);
  if (err.error != QJsonParseError::NoError || !doc.isObject())
    return QStringLiteral("invalid run JSON: %1").arg(err.errorString());

  const QJsonObject run = doc.object();
  if (!run.contains(QStringLiteral("id")))
    return QStringLiteral("run is missing 'id'");

  m_runs.append(run);
  publishRuns();
  logEvent("ingested run id=" +
           run.value(QStringLiteral("id")).toString().toStdString());
  return QString(); // "" == success
}

void PerunAnalyticsBackend::publishRuns() {
  setRunsJson(QString::fromUtf8(
      QJsonDocument(m_runs).toJson(QJsonDocument::Compact)));
}
