#include "perun_analytics_backend.h"

#include <cmath>
#include <iostream>

#include <QByteArray>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QLatin1String>
#include <QStandardPaths>
#include <QTimer>
#include <QVariantList>

#include "logos_sdk.h"
#include "logos_types.h"

#include "gpx.h"
#include "gzip.h"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_analytics backend] " << what << std::endl;
}
qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }

// Raw bytes per chunk; base64 (~1.33x) + envelope stays under Waku's 150 KB.
constexpr int kChunkBudget = 100000;

// A plausible synthetic run near Brno (~3 m/s, GPS/elevation jitter, drifting
// HR) — stand-in for the mobile app's capture until it exists.
perun::Track makeSyntheticTrack(int seconds, int hz) {
  perun::Track tr;
  tr.hasAlt = tr.hasHr = true;
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
    lat += (speed / hz) * std::cos(heading) / mLat;
    lon += (speed / hz) * std::sin(heading) / mLon;
    alt += (rnd() - 0.5) * 0.8;
    hr = std::min(185.0, hr + (rnd() - 0.45) * 0.5);
    perun::GeoPoint p;
    p.lat = lat; p.lon = lon; p.alt = alt;
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
  QString dir = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
  if (dir.isEmpty())
    dir = QDir::homePath() + QStringLiteral("/.local/share");
  m_dataDir = dir + QStringLiteral("/perun");
  QDir().mkpath(m_dataDir);

  if (!m_store.open((m_dataDir + QStringLiteral("/runs.db")).toStdString())) {
    logEvent("run store open failed");
    return;
  }
  for (const std::string &j : m_store.loadAll()) {
    QJsonParseError err{};
    const QJsonDocument doc =
        QJsonDocument::fromJson(QByteArray::fromStdString(j), &err);
    if (err.error == QJsonParseError::NoError && doc.isObject())
      m_runs.append(doc.object());
  }
  logEvent("loaded " + std::to_string(m_runs.size()) + " persisted runs");
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
        QJsonParseError err{};
        const QJsonDocument doc =
            QJsonDocument::fromJson(data.at(2).toByteArray(), &err);
        if (err.error != QJsonParseError::NoError || !doc.isObject())
          return;
        const QJsonObject env = doc.object();
        if (env.value(QStringLiteral("type")).toString() !=
            QLatin1String("CHUNK"))
          return;

        const QString id = env.value(QStringLiteral("id")).toString();
        const int seq = env.value(QStringLiteral("seq")).toInt();
        const int total = env.value(QStringLiteral("total")).toInt();
        const QByteArray part = QByteArray::fromBase64(
            env.value(QStringLiteral("gz")).toString().toLatin1());

        ChunkBuf &buf = m_chunks[id];
        buf.total = total;
        buf.parts.insert(seq, part);
        if (buf.parts.size() < total)
          return;

        QByteArray gz;
        for (int i = 0; i < total; ++i)
          gz += buf.parts.value(i);
        m_chunks.remove(id);
        logEvent("reassembled " + std::to_string(total) + " chunk(s) for " +
                 id.toStdString());
        ingestGzTrack(id, gz);
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
  perun::Track tr = makeSyntheticTrack(/*seconds=*/1200, /*hz=*/1);
  tr.name = QStringLiteral("Morning run %1").arg(n).toStdString();

  const QByteArray gz = perun::gzip(perun::toGpx(tr));
  const QString runId = QStringLiteral("run-%1-%2").arg(nowMs()).arg(n);

  const QString err = sendChunks(runId, gz);
  if (!err.isEmpty())
    return err;

  // Local echo — the relay won't loop our own message back.
  ingestGzTrack(runId, gz);
  return QString();
}

QString PerunAnalyticsBackend::sendChunks(const QString &runId,
                                          const QByteArray &gz) {
  const int total = std::max(
      1, static_cast<int>((gz.size() + kChunkBudget - 1) / kChunkBudget));
  for (int seq = 0; seq < total; ++seq) {
    const QByteArray part = gz.mid(seq * kChunkBudget, kChunkBudget);
    const QJsonObject env{
        {"v", 1}, {"type", "CHUNK"}, {"id", runId}, {"seq", seq},
        {"total", total},
        {"gz", QString::fromLatin1(part.toBase64())}};
    LogosResult r = modules().delivery_module.send(
        kTopic, QJsonDocument(env).toJson(QJsonDocument::Compact));
    if (!r.success) {
      logEvent("send chunk failed: " + r.getError().toStdString());
      return r.getError();
    }
  }
  logEvent("published " + std::to_string(total) + " chunk(s), " +
           std::to_string(gz.size()) + "B gz for " + runId.toStdString());
  return QString();
}

void PerunAnalyticsBackend::ingestGzTrack(const QString &runId,
                                          const QByteArray &gz) {
  try {
    const perun::Track tr = perun::fromGpx(perun::gunzip(gz));
    addRun(runToJson(runId, tr),
           QByteArray(gz.constData(), gz.size()));
  } catch (const std::exception &e) {
    logEvent(std::string("ingest failed: ") + e.what());
  }
}

QJsonObject PerunAnalyticsBackend::runToJson(const QString &runId,
                                             const perun::Track &tr) const {
  const perun::RunSummary s = perun::computeSummary(tr);
  const std::vector<perun::Split> splits = perun::computeSplits(tr);

  QJsonObject run{
      {"id", runId},
      {"name", QString::fromStdString(tr.name)},
      {"startTs", tr.points.empty() ? nowMs()
                                    : static_cast<qint64>(tr.points.front().t)},
      {"points", static_cast<int>(tr.points.size())},
  };
  run[QStringLiteral("summary")] = QJsonObject{
      {"distanceM", s.distanceM}, {"durationS", s.durationS},
      {"avgPaceSecPerKm", s.avgPaceSecPerKm}, {"elevGainM", s.elevGainM},
      {"avgHr", s.avgHr}, {"hasHr", s.hasHr}};
  QJsonArray sp;
  for (const auto &x : splits)
    sp.append(QJsonObject{{"index", x.index}, {"distanceM", x.distanceM},
                          {"durationS", x.durationS},
                          {"paceSecPerKm", x.paceSecPerKm},
                          {"elevGainM", x.elevGainM}, {"avgHr", x.avgHr}});
  run[QStringLiteral("splits")] = sp;
  return run;
}

void PerunAnalyticsBackend::addRun(const QJsonObject &run,
                                   const QByteArray &gz) {
  const QJsonValue id = run.value(QStringLiteral("id"));
  if (id.toString().isEmpty())
    return;
  for (int i = 0; i < m_runs.size(); ++i)
    if (m_runs.at(i).toObject().value(QStringLiteral("id")) == id)
      return;

  m_runs.prepend(run);
  publishRuns();

  const QByteArray j = QJsonDocument(run).toJson(QJsonDocument::Compact);
  m_store.upsert(id.toString().toStdString(),
                 static_cast<int64_t>(run.value(QStringLiteral("startTs")).toDouble()),
                 std::string(j.constData(), static_cast<size_t>(j.size())),
                 std::string(gz.constData(), static_cast<size_t>(gz.size())));
  logEvent("added run id=" + id.toString().toStdString());
}

void PerunAnalyticsBackend::publishRuns() {
  setRunsJson(QString::fromUtf8(
      QJsonDocument(m_runs).toJson(QJsonDocument::Compact)));
}

QString PerunAnalyticsBackend::trackJson(QString runId) {
  const std::string gzs = m_store.getGpx(runId.toStdString());
  if (gzs.empty())
    return QStringLiteral("[]");
  try {
    const perun::Track tr = perun::fromGpx(
        perun::gunzip(QByteArray(gzs.data(), static_cast<int>(gzs.size()))));
    QJsonArray pts;
    for (const auto &p : tr.points)
      pts.append(QJsonObject{{"lat", p.lat}, {"lon", p.lon}, {"alt", p.alt},
                             {"hr", p.hr}, {"t", static_cast<qint64>(p.t)}});
    return QString::fromUtf8(QJsonDocument(pts).toJson(QJsonDocument::Compact));
  } catch (const std::exception &e) {
    logEvent(std::string("trackJson failed: ") + e.what());
    return QStringLiteral("[]");
  }
}

QString PerunAnalyticsBackend::exportGpx(QString runId) {
  const std::string gzs = m_store.getGpx(runId.toStdString());
  if (gzs.empty())
    return QString();
  try {
    const QByteArray gpx =
        perun::gunzip(QByteArray(gzs.data(), static_cast<int>(gzs.size())));
    const QString dir = m_dataDir + QStringLiteral("/exports");
    QDir().mkpath(dir);
    const QString path = dir + "/" + runId + QStringLiteral(".gpx");
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly))
      return QString();
    f.write(gpx);
    f.close();
    logEvent("exported " + path.toStdString());
    return path;
  } catch (const std::exception &e) {
    logEvent(std::string("exportGpx failed: ") + e.what());
    return QString();
  }
}
