#include "perun_analytics_backend.h"

#include <cmath>
#include <iostream>

#include <QByteArray>
#include <QDateTime>
#include <QDir>
#include <QJsonDocument>
#include <QLatin1String>
#include <QStandardPaths>
#include <QTimer>
#include <QVariantList>

#include "logos_sdk.h"
#include "logos_types.h"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_analytics backend] " << what << std::endl;
}
qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }

// A plausible synthetic run near Brno (~3 m/s, GPS/elevation jitter, drifting
// HR) — stand-in for the mobile app's capture until it exists.
perun::Track makeSyntheticTrack(int seconds, int hz) {
  perun::Track tr;
  tr.hasAlt = tr.hasHr = tr.hasSpeed = true;
  double lat = 49.1951, lon = 16.6068, alt = 250, hr = 120, heading = 0;
  qint64 t = nowMs();
  const double mLat = 111320.0, mLon = 111320.0 * std::cos(lat * M_PI / 180.0);
  uint32_t seed = static_cast<uint32_t>(t) ^ 0x9e3779b9u;
  auto rnd = [&]() {
    seed = seed * 1103515245u + 12345u;
    return ((seed >> 16) & 0x7fff) / 32767.0;
  };
  const int n = seconds * hz;
  for (int i = 0; i < n; ++i) {
    heading += (rnd() - 0.5) * 0.3;
    const double speed = 2.8 + rnd() * 0.8;
    const double dist = speed / hz;
    lat += dist * std::cos(heading) / mLat;
    lon += dist * std::sin(heading) / mLon;
    alt += (rnd() - 0.5) * 0.8;
    hr = std::min(185.0, hr + (rnd() - 0.45) * 0.5);
    perun::GeoPoint p;
    p.lat = lat; p.lon = lon; p.alt = alt; p.speed = speed;
    p.hr = static_cast<int>(std::llround(hr)); p.t = t;
    tr.points.push_back(p);
    t += static_cast<qint64>(1000 / hz);
  }
  return tr;
}
} // namespace

const QString PerunAnalyticsBackend::kTopic =
    QStringLiteral("/perun/1/demo/proto");

void PerunAnalyticsBackend::onContextReady() {
  logEvent("onContextReady — loading store, scheduling delivery bootstrap");
  openStoreAndLoad();
  setTopic(kTopic);
  setStatus(QStringLiteral("Starting node…"));
  QTimer::singleShot(0, [this]() { bootstrap(); });
}

void PerunAnalyticsBackend::openStoreAndLoad() {
  // ui_qml plugins have no host-provided persistence path, so use a stable
  // per-user data dir of our own.
  QString dir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
  if (dir.isEmpty())
    dir = QDir::homePath() + QStringLiteral("/.local/share");
  dir += QStringLiteral("/perun");
  QDir().mkpath(dir);
  const QString dbPath = dir + QStringLiteral("/runs.db");

  if (!m_store.open(dbPath.toStdString())) {
    logEvent("run store open failed at " + dbPath.toStdString());
    return;
  }
  for (const std::string &j : m_store.loadAll()) {
    QJsonParseError err{};
    const QJsonDocument doc =
        QJsonDocument::fromJson(QByteArray::fromStdString(j), &err);
    if (err.error == QJsonParseError::NoError && doc.isObject())
      m_runs.append(doc.object());
  }
  logEvent("loaded " + std::to_string(m_runs.size()) + " persisted runs from " +
           dbPath.toStdString());
  if (!m_runs.isEmpty())
    publishRuns();
}

void PerunAnalyticsBackend::bootstrap() {
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
        if (err.error != QJsonParseError::NoError || !doc.isObject())
          return;
        const QJsonObject env = doc.object();
        if (env.value(QStringLiteral("type")).toString() != QLatin1String("RUN"))
          return;
        const QByteArray blob = QByteArray::fromBase64(
            env.value(QStringLiteral("track")).toString().toUtf8());
        try {
          const perun::Track tr = perun::decodeTrack(
              reinterpret_cast<const uint8_t *>(blob.constData()),
              static_cast<size_t>(blob.size()));
          logEvent("received RUN with " + std::to_string(tr.points.size()) +
                   " points");
          ingestTrackRun(env.value(QStringLiteral("run")).toObject(), tr);
        } catch (const std::exception &e) {
          logEvent(std::string("track decode failed: ") + e.what());
        }
      });

  const QJsonObject cfg{
      {"logLevel", "INFO"}, {"mode", "Core"}, {"preset", "logos.dev"}};
  const QString cfgJson =
      QString::fromUtf8(QJsonDocument(cfg).toJson(QJsonDocument::Compact));

  LogosResult created = modules().delivery_module.createNode(cfgJson);
  if (created.success) {
    LogosResult started = modules().delivery_module.start();
    if (!started.success)
      logEvent("start failed: " + started.getError().toStdString());
  } else {
    logEvent("createNode failed (may already be running): " +
             created.getError().toStdString());
  }

  LogosResult sub = modules().delivery_module.subscribe(kTopic);
  if (!sub.success) {
    setStatus(QStringLiteral("subscribe failed: %1").arg(sub.getError()));
    return;
  }

  m_nodeReady = true;
  setReady(true);
  setStatus(QStringLiteral("Connected · %1").arg(kTopic));
  logEvent("node ready on " + kTopic.toStdString());

  if (qEnvironmentVariableIsSet("PERUN_TEST_AUTOPUBLISH")) {
    logEvent("PERUN_TEST_AUTOPUBLISH set — publishing a sample run in 12s");
    QTimer::singleShot(12000, [this]() { publishSampleRun(); });
  }
}

QString PerunAnalyticsBackend::publishSampleRun() {
  if (!m_nodeReady)
    return QStringLiteral("Node not ready");

  const int n = m_runs.size() + 1;
  const perun::Track tr = makeSyntheticTrack(/*seconds=*/1200, /*hz=*/1);

  const QJsonObject meta{
      {"id", QStringLiteral("run-%1-%2").arg(nowMs()).arg(n)},
      {"name", QStringLiteral("Morning run %1").arg(n)},
      {"startTs", tr.points.empty() ? nowMs() : tr.points.front().t},
  };

  const std::vector<uint8_t> enc = perun::encodeTrack(tr);
  const QByteArray b64 =
      QByteArray(reinterpret_cast<const char *>(enc.data()),
                 static_cast<int>(enc.size()))
          .toBase64();

  const QJsonObject env{
      {"v", 1}, {"type", "RUN"}, {"run", meta}, {"track", QString::fromLatin1(b64)}};
  const QByteArray bytes = QJsonDocument(env).toJson(QJsonDocument::Compact);

  LogosResult r = modules().delivery_module.send(kTopic, bytes);
  if (!r.success) {
    logEvent("send failed: " + r.getError().toStdString());
    return r.getError();
  }
  logEvent("published RUN (" + std::to_string(enc.size()) + "B track, " +
           std::to_string(bytes.size()) + "B msg) requestId=" +
           r.getString().toStdString());

  // Local echo — relay won't loop our own message back.
  ingestTrackRun(meta, tr);
  return QString();
}

QString PerunAnalyticsBackend::ingestRun(QString runJson) {
  QJsonParseError err{};
  const QJsonDocument doc = QJsonDocument::fromJson(runJson.toUtf8(), &err);
  if (err.error != QJsonParseError::NoError || !doc.isObject())
    return QStringLiteral("invalid run JSON: %1").arg(err.errorString());
  addRun(doc.object());
  return QString();
}

QJsonObject PerunAnalyticsBackend::runToJson(const QJsonObject &meta,
                                             const perun::Track &tr) const {
  const perun::RunSummary s = perun::computeSummary(tr);
  const std::vector<perun::Split> splits = perun::computeSplits(tr);

  QJsonObject run = meta; // id, name, startTs
  run[QStringLiteral("summary")] = QJsonObject{
      {"distanceM", s.distanceM},
      {"durationS", s.durationS},
      {"avgPaceSecPerKm", s.avgPaceSecPerKm},
      {"elevGainM", s.elevGainM},
      {"avgHr", s.avgHr},
      {"hasHr", s.hasHr},
  };
  QJsonArray sp;
  for (const auto &x : splits)
    sp.append(QJsonObject{
        {"index", x.index},
        {"distanceM", x.distanceM},
        {"durationS", x.durationS},
        {"paceSecPerKm", x.paceSecPerKm},
        {"elevGainM", x.elevGainM},
        {"avgHr", x.avgHr},
    });
  run[QStringLiteral("splits")] = sp;
  run[QStringLiteral("points")] = static_cast<int>(tr.points.size());
  return run;
}

void PerunAnalyticsBackend::ingestTrackRun(const QJsonObject &meta,
                                           const perun::Track &tr) {
  addRun(runToJson(meta, tr));
}

void PerunAnalyticsBackend::addRun(const QJsonObject &run) {
  if (!run.contains(QStringLiteral("id"))) {
    logEvent("skipped run without id");
    return;
  }
  const QJsonValue id = run.value(QStringLiteral("id"));
  for (int i = 0; i < m_runs.size(); ++i)
    if (m_runs.at(i).toObject().value(QStringLiteral("id")) == id)
      return;
  m_runs.prepend(run); // newest first
  publishRuns();

  // Persist to the local SQLite store so runs survive restarts.
  const QByteArray j = QJsonDocument(run).toJson(QJsonDocument::Compact);
  m_store.upsert(id.toString().toStdString(),
                 static_cast<int64_t>(run.value(QStringLiteral("startTs")).toDouble()),
                 std::string(j.constData(), static_cast<size_t>(j.size())));
  logEvent("added run id=" + id.toString().toStdString());
}

void PerunAnalyticsBackend::publishRuns() {
  setRunsJson(QString::fromUtf8(
      QJsonDocument(m_runs).toJson(QJsonDocument::Compact)));
}
