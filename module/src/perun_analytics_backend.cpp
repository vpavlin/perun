#include "perun_analytics_backend.h"

#include <cmath>
#include <iostream>

#include <QByteArray>
#include <QDateTime>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QLatin1String>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QVariantList>

#include "logos_sdk.h"
#include "logos_types.h"

#include "gpx.h"
#include "gzip.h"
#include "qrcodegen.hpp"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_analytics backend] " << what << std::endl;
}
qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }

// QByteArray <-> perun::Bytes at the crypto boundary.
perun::Bytes toBytes(const QByteArray &b) {
  return perun::Bytes(reinterpret_cast<const uint8_t *>(b.constData()),
                      reinterpret_cast<const uint8_t *>(b.constData()) + b.size());
}
QByteArray fromBytes(const perun::Bytes &b) {
  return QByteArray(reinterpret_cast<const char *>(b.data()),
                    static_cast<int>(b.size()));
}

// Raw bytes per chunk; base64 (~1.33x) + envelope stays under Waku's 150 KB.
constexpr int kChunkBudget = 100000;

// OSM raster basemap (ensureTile). Cap zoom per the OSM tile usage policy and
// send an identifying User-Agent on every request:
// https://operations.osmfoundation.org/policies/tiles/
constexpr int kMaxTileZoom = 16;
constexpr int kTileTimeoutMs = 8000;
const char *const kTileUserAgent = "Perun/1.4 (+https://github.com/vpavlin/perun)";

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

void PerunAnalyticsBackend::onContextReady() {
  logEvent("onContextReady — loading store + pairing secret, scheduling bootstrap");
  openStoreAndLoad();
  loadOrCreateSecret();
  setStatus(QStringLiteral("Starting node…"));
  QTimer::singleShot(0, [this]() { bootstrap(); });
}

void PerunAnalyticsBackend::applyIdentity(const perun::Bytes &secret) {
  m_id = perun::deriveIdentity(secret);
  m_topic = QString::fromStdString(perun::topicFor(m_id));
  const QString fp = QString::fromStdString(m_id.fpWords[0]) + " " +
                     QString::fromStdString(m_id.fpWords[1]) + " " +
                     QString::fromStdString(m_id.fpWords[2]);
  setFingerprint(fp);
  setPairingUri(QString::fromStdString(perun::pairingUri(secret)));
  logEvent("pairing fingerprint: " + fp.toStdString());
}

void PerunAnalyticsBackend::loadOrCreateSecret() {
  const QString path = m_dataDir + QStringLiteral("/pair.key");
  QFile f(path);
  perun::Bytes secret;
  if (f.open(QIODevice::ReadOnly)) {
    const QByteArray raw = f.read(32);
    f.close();
    if (raw.size() == 32) secret = toBytes(raw);
  }
  if (secret.size() != 32) {
    secret = perun::randomSecret();
    QSaveFile out(path);
    if (out.open(QIODevice::WriteOnly)) {
      out.write(fromBytes(secret));
      out.commit();
      QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
    }
    logEvent("generated a new pairing secret");
  }
  applyIdentity(secret);
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
        // Payload on the wire is nonce(12)‖ChaCha20-Poly1305(env, aad=topic).
        // Decrypt with our pairing key; a bad tag = not ours / tampered → drop.
        bool ok = false;
        const perun::Bytes pt =
            perun::open(m_id, toBytes(data.at(2).toByteArray()),
                        m_topic.toStdString(), &ok);
        if (!ok)
          return;
        QJsonParseError err{};
        const QJsonDocument doc = QJsonDocument::fromJson(fromBytes(pt), &err);
        if (err.error != QJsonParseError::NoError || !doc.isObject())
          return;
        const QJsonObject env = doc.object();
        if (env.value(QStringLiteral("type")).toString() !=
            QLatin1String("CHUNK"))
          return;

        const QString id = env.value(QStringLiteral("id")).toString();
        const int rev = env.value(QStringLiteral("rev")).toInt(1); // v1 senders had none
        const int seq = env.value(QStringLiteral("seq")).toInt();
        const int total = env.value(QStringLiteral("total")).toInt();
        const QByteArray part = QByteArray::fromBase64(
            env.value(QStringLiteral("gz")).toString().toLatin1());

        // Key reassembly by id+rev so an edit arriving mid-transfer of an older
        // revision never splices chunks from two revisions into one gzip stream.
        const QString key = id + QStringLiteral("@") + QString::number(rev);
        ChunkBuf &buf = m_chunks[key];
        buf.total = total;
        buf.parts.insert(seq, part);
        if (buf.parts.size() < total)
          return;

        QByteArray gz;
        for (int i = 0; i < total; ++i)
          gz += buf.parts.value(i);
        m_chunks.remove(key);
        logEvent("reassembled " + std::to_string(total) + " chunk(s) for " +
                 id.toStdString() + " rev " + std::to_string(rev));
        ingestGzTrack(id, rev, gz);
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

  LogosResult sub = modules().delivery_module.subscribe(m_topic);
  if (!sub.success) {
    setStatus(QStringLiteral("subscribe failed: %1").arg(sub.getError()));
    return;
  }

  m_nodeReady = true;
  setReady(true);
  // Never surface the derived topic (secret-adjacent) — the fingerprint PROP is
  // the user-facing pairing identity.
  setStatus(QStringLiteral("Connected · paired"));
  logEvent("node ready on derived topic");

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

  const QString err = sendChunks(runId, /*rev=*/1, gz);
  if (!err.isEmpty())
    return err;

  // Local echo — the relay won't loop our own message back.
  ingestGzTrack(runId, /*rev=*/1, gz);
  return QString();
}

QString PerunAnalyticsBackend::sendChunks(const QString &runId, int rev,
                                          const QByteArray &gz) {
  const int total = std::max(
      1, static_cast<int>((gz.size() + kChunkBudget - 1) / kChunkBudget));
  for (int seq = 0; seq < total; ++seq) {
    const QByteArray part = gz.mid(seq * kChunkBudget, kChunkBudget);
    const QJsonObject env{
        {"v", 3}, {"type", "CHUNK"}, {"id", runId}, {"rev", rev}, {"seq", seq},
        {"total", total},
        {"gz", QString::fromLatin1(part.toBase64())}};
    // Encrypt the envelope for the paired phone (same seal format it decrypts).
    const QByteArray sealed = fromBytes(perun::seal(
        m_id, toBytes(QJsonDocument(env).toJson(QJsonDocument::Compact)),
        m_topic.toStdString()));
    LogosResult r = modules().delivery_module.send(m_topic, sealed);
    if (!r.success) {
      logEvent("send chunk failed: " + r.getError().toStdString());
      return r.getError();
    }
  }
  logEvent("published " + std::to_string(total) + " chunk(s), " +
           std::to_string(gz.size()) + "B gz for " + runId.toStdString());
  return QString();
}

void PerunAnalyticsBackend::ingestGzTrack(const QString &runId, int rev,
                                          const QByteArray &gz) {
  try {
    const perun::Track tr = perun::fromGpx(perun::gunzip(gz));
    addRun(runToJson(runId, rev, tr),
           QByteArray(gz.constData(), gz.size()));
  } catch (const std::exception &e) {
    logEvent(std::string("ingest failed: ") + e.what());
  }
}

QJsonObject PerunAnalyticsBackend::runToJson(const QString &runId, int rev,
                                             const perun::Track &tr) const {
  const perun::RunSummary s = perun::computeSummary(tr);
  const std::vector<perun::Split> splits = perun::computeSplits(tr);

  QJsonObject run{
      {"id", runId},
      {"rev", rev},
      {"name", QString::fromStdString(tr.name)},
      {"category", QString::fromStdString(tr.type)},
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
  const QString id = run.value(QStringLiteral("id")).toString();
  if (id.isEmpty())
    return;
  const int rev = run.value(QStringLiteral("rev")).toInt(1);

  // Last-write-wins by rev: unknown id → insert; newer rev → replace the stored
  // copy; same-or-older rev → ignore (idempotent replay / stale edit).
  int existing = -1;
  for (int i = 0; i < m_runs.size(); ++i)
    if (m_runs.at(i).toObject().value(QStringLiteral("id")).toString() == id) {
      existing = i;
      break;
    }
  if (existing >= 0) {
    const int storedRev = m_runs.at(existing).toObject().value(QStringLiteral("rev")).toInt(1);
    if (rev <= storedRev)
      return; // not newer — drop
    m_runs.replace(existing, run);
    logEvent("replaced run id=" + id.toStdString() + " rev " +
             std::to_string(storedRev) + "→" + std::to_string(rev));
  } else {
    m_runs.prepend(run);
    logEvent("added run id=" + id.toStdString() + " rev " + std::to_string(rev));
  }
  publishRuns();

  const QByteArray j = QJsonDocument(run).toJson(QJsonDocument::Compact);
  m_store.upsert(id.toStdString(),
                 static_cast<int64_t>(run.value(QStringLiteral("startTs")).toDouble()),
                 std::string(j.constData(), static_cast<size_t>(j.size())),
                 std::string(gz.constData(), static_cast<size_t>(gz.size())));
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

QString PerunAnalyticsBackend::resetPairing() {
  const QString oldTopic = m_topic;
  const perun::Bytes secret = perun::randomSecret();
  if (secret.size() != 32)
    return QStringLiteral("failed to generate secret");

  // Persist the new secret, then re-derive identity + topic.
  const QString path = m_dataDir + QStringLiteral("/pair.key");
  QSaveFile out(path);
  if (out.open(QIODevice::WriteOnly)) {
    out.write(fromBytes(secret));
    out.commit();
    QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
  }
  applyIdentity(secret);

  // Move the subscription to the new derived topic.
  if (m_nodeReady) {
    if (!oldTopic.isEmpty())
      modules().delivery_module.unsubscribe(oldTopic);
    LogosResult sub = modules().delivery_module.subscribe(m_topic);
    if (!sub.success)
      return sub.getError();
  }
  logEvent("pairing reset — old phones unpaired");
  return QString();
}

QString PerunAnalyticsBackend::qrMatrix(QString text) {
  if (text.isEmpty())
    return QStringLiteral("{\"ok\":false,\"error\":\"empty\"}");
  try {
    const qrcodegen::QrCode qr = qrcodegen::QrCode::encodeText(
        text.toUtf8().constData(), qrcodegen::QrCode::Ecc::MEDIUM);
    const int n = qr.getSize();
    QJsonArray cells;
    for (int y = 0; y < n; ++y)
      for (int x = 0; x < n; ++x)
        cells.append(qr.getModule(x, y) ? 1 : 0);
    const QJsonObject o{{"ok", true}, {"n", n}, {"cells", cells}};
    return QString::fromUtf8(QJsonDocument(o).toJson(QJsonDocument::Compact));
  } catch (const std::exception &e) {
    logEvent(std::string("qrMatrix failed: ") + e.what());
    return QStringLiteral("{\"ok\":false,\"error\":\"encode failed\"}");
  }
}

QString PerunAnalyticsBackend::setTileRoot(QString dirUrl) {
  // QML passes Qt.resolvedUrl(".") — a file:// URL to the plugin's qml dir, the
  // one place the sandbox lets Image load from. Cache tiles under it.
  QString path = QUrl(dirUrl).isLocalFile() ? QUrl(dirUrl).toLocalFile() : dirUrl;
  while (path.endsWith('/'))
    path.chop(1);
  m_tileRoot = path;
  logEvent("tile root = " + m_tileRoot.toStdString());
  return QString();
}

QString PerunAnalyticsBackend::ensureTile(int z, int x, int y) {
  // Reject anything off the Web-Mercator grid for this zoom (and honour the
  // OSM zoom cap) — never emit a request that can't be a real tile.
  if (z < 0 || z > kMaxTileZoom)
    return QString();
  const int n = 1 << z;
  if (x < 0 || x >= n || y < 0 || y >= n)
    return QString();

  // Cache under the sandbox-readable plugin dir (set by the view); fall back to
  // the data dir only if the view never called setTileRoot (tiles then unusable
  // by QML, but the backend still won't error).
  const QString dir =
      (m_tileRoot.isEmpty() ? m_dataDir : m_tileRoot) + QStringLiteral("/tiles");
  const QString path =
      QStringLiteral("%1/%2_%3_%4.png").arg(dir).arg(z).arg(x).arg(y);

  // Cache hit — serve straight from disk, never hit the network again.
  const QFileInfo cached(path);
  if (cached.exists() && cached.size() > 0)
    return QUrl::fromLocalFile(path).toString();

  if (!QDir().mkpath(dir))
    return QString();

  if (!m_net)
    m_net = new QNetworkAccessManager(this);

  const QString url =
      QStringLiteral("https://tile.openstreetmap.org/%1/%2/%3.png")
          .arg(z)
          .arg(x)
          .arg(y);
  QNetworkRequest req{QUrl(url)};
  req.setHeader(QNetworkRequest::UserAgentHeader,
                QString::fromLatin1(kTileUserAgent));
  req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                   QNetworkRequest::NoLessSafeRedirectPolicy);

  // Block this backend thread until the tile arrives (or times out). The QML
  // view runs in a separate process, so the UI stays responsive; the map's
  // sequential fetch driver keeps at most one request in flight, so no nested
  // event loops. Tiles are cached, so this cost is paid once per tile.
  QNetworkReply *reply = m_net->get(req);
  QEventLoop loop;
  QTimer timer;
  timer.setSingleShot(true);
  QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
  QObject::connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
  timer.start(kTileTimeoutMs);
  loop.exec();

  const bool ok = timer.isActive() && reply->isFinished() &&
                  reply->error() == QNetworkReply::NoError;
  const QByteArray data = ok ? reply->readAll() : QByteArray();
  reply->abort(); // no-op if already finished; cancels a timed-out request
  reply->deleteLater();

  if (!ok || data.isEmpty()) {
    logEvent("tile fetch failed " + std::to_string(z) + "/" +
             std::to_string(x) + "/" + std::to_string(y));
    return QString(); // offline / error — QML falls back to the plain track
  }

  // Atomic write: a truncated download must never be cached and served forever.
  QSaveFile f(path);
  if (!f.open(QIODevice::WriteOnly))
    return QString();
  f.write(data);
  if (!f.commit())
    return QString();

  return QUrl::fromLocalFile(path).toString();
}
