#include "perun_analytics_backend.h"

#include <iostream>

#include <QByteArray>
#include <QDateTime>
#include <QJsonDocument>
#include <QLatin1String>
#include <QTimer>
#include <QVariantList>

// Generated umbrella: typed modules() wrappers from metadata.json#dependencies
// (here delivery_module). logos_types.h provides LogosResult.
#include "logos_sdk.h"
#include "logos_types.h"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_analytics backend] " << what << std::endl;
}
qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }
} // namespace

// One per-owner content topic (LIP-23). Fixed until owner identity is wired.
const QString PerunAnalyticsBackend::kTopic =
    QStringLiteral("/perun/1/demo/proto");

void PerunAnalyticsBackend::onContextReady() {
  logEvent("onContextReady — scheduling delivery bootstrap");
  setTopic(kTopic);
  setStatus(QStringLiteral("Starting node…"));
  // Defer: createNode/start are synchronous and can block briefly; returning
  // promptly lets the QML replica reach Valid sooner. modules() stays live.
  QTimer::singleShot(0, [this]() { bootstrap(); });
}

void PerunAnalyticsBackend::bootstrap() {
  // --- events before start ---
  modules().delivery_module.on(
      "connectionStateChanged", [this](const QVariantList &data) {
        if (!data.isEmpty() && m_nodeReady)
          setStatus(data.at(0).toString());
      });

  modules().delivery_module.on(
      "messageReceived", [this](const QVariantList &data) {
        if (data.size() < 3)
          return;
        const QByteArray payload = data.at(2).toByteArray();
        QJsonParseError err{};
        const QJsonDocument doc = QJsonDocument::fromJson(payload, &err);
        if (err.error != QJsonParseError::NoError || !doc.isObject()) {
          logEvent("ignored non-JSON payload");
          return;
        }
        const QJsonObject env = doc.object();
        if (env.value(QStringLiteral("type")).toString() !=
            QLatin1String("RUN_META"))
          return;
        logEvent("received RUN_META");
        ingestRunObject(env.value(QStringLiteral("run")).toObject());
      });

  // --- create + start against the logos.dev fleet ---
  const QJsonObject cfg{
      {"logLevel", "INFO"},
      {"mode", "Core"},
      {"preset", "logos.dev"},
  };
  const QString cfgJson =
      QString::fromUtf8(QJsonDocument(cfg).toJson(QJsonDocument::Compact));

  LogosResult created = modules().delivery_module.createNode(cfgJson);
  if (created.success) {
    logEvent("createNode ok, starting");
    LogosResult started = modules().delivery_module.start();
    if (!started.success)
      logEvent("start failed: " + started.getError().toStdString());
  } else {
    // delivery_module is a shared singleton — another app may have created the
    // node already. Proceed to subscribe regardless.
    logEvent("createNode failed (may already be running): " +
             created.getError().toStdString());
  }

  LogosResult sub = modules().delivery_module.subscribe(kTopic);
  if (!sub.success) {
    setStatus(QStringLiteral("subscribe failed: %1").arg(sub.getError()));
    logEvent("subscribe failed: " + sub.getError().toStdString());
    return;
  }

  m_nodeReady = true;
  setReady(true);
  setStatus(QStringLiteral("Connected · %1").arg(kTopic));
  logEvent("node ready on " + kTopic.toStdString());

  // Test hook: with PERUN_TEST_AUTOPUBLISH set, publish one sample run a few
  // seconds after the node is ready (gives peers time to connect / a second
  // instance time to subscribe). Off in normal operation.
  if (qEnvironmentVariableIsSet("PERUN_TEST_AUTOPUBLISH")) {
    logEvent("PERUN_TEST_AUTOPUBLISH set — publishing a sample run in 12s");
    QTimer::singleShot(12000, [this]() {
      const QString e = publishSampleRun();
      if (!e.isEmpty())
        logEvent("autopublish failed: " + e.toStdString());
    });
  }
}

QString PerunAnalyticsBackend::publishSampleRun() {
  if (!m_nodeReady)
    return QStringLiteral("Node not ready");

  const int n = m_runs.size() + 1;
  const QJsonObject run{
      {"id", QStringLiteral("run-%1-%2").arg(nowMs()).arg(n)},
      {"name", QStringLiteral("Sample run %1").arg(n)},
      {"startTs", nowMs()},
      {"distanceM", 4000 + n * 1200},
      {"durationS", 1500 + n * 300},
      {"avgPaceSecPerKm", 300 + (n % 5) * 8},
  };
  const QJsonObject env{{"v", 1}, {"type", "RUN_META"}, {"run", run}};
  const QByteArray bytes = QJsonDocument(env).toJson(QJsonDocument::Compact);

  LogosResult r = modules().delivery_module.send(kTopic, bytes);
  if (!r.success) {
    logEvent("send failed: " + r.getError().toStdString());
    return r.getError();
  }
  logEvent("published RUN_META requestId=" + r.getString().toStdString());

  // Local echo — the relay won't loop our own message back.
  ingestRunObject(run);
  return QString();
}

QString PerunAnalyticsBackend::ingestRun(QString runJson) {
  QJsonParseError err{};
  const QJsonDocument doc = QJsonDocument::fromJson(runJson.toUtf8(), &err);
  if (err.error != QJsonParseError::NoError || !doc.isObject())
    return QStringLiteral("invalid run JSON: %1").arg(err.errorString());
  ingestRunObject(doc.object());
  return QString();
}

void PerunAnalyticsBackend::ingestRunObject(const QJsonObject &run) {
  if (run.isEmpty() || !run.contains(QStringLiteral("id"))) {
    logEvent("skipped run without id");
    return;
  }
  // De-dup by id (handles local echo vs. a possible network echo).
  const QJsonValue id = run.value(QStringLiteral("id"));
  for (int i = 0; i < m_runs.size(); ++i)
    if (m_runs.at(i).toObject().value(QStringLiteral("id")) == id)
      return;

  m_runs.append(run);
  publishRuns();
  logEvent("ingested run id=" + id.toString().toStdString());
}

void PerunAnalyticsBackend::publishRuns() {
  setRunsJson(QString::fromUtf8(
      QJsonDocument(m_runs).toJson(QJsonDocument::Compact)));
}
