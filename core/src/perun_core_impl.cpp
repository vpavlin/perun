#include "perun_core_impl.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>

#include <QByteArray>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QLatin1String>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QUuid>
#include <QVariantList>

#include "blob_server.h"
#include "gpx.h"
#include "gzip.h"

#include "logos_sdk.h"
#include "logos_types.h"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_core] " << what << std::endl;
}
qint64 nowMs() { return QDateTime::currentMSecsSinceEpoch(); }

perun::Bytes toBytes(const QByteArray &b) {
  return perun::Bytes(reinterpret_cast<const uint8_t *>(b.constData()),
                      reinterpret_cast<const uint8_t *>(b.constData()) + b.size());
}
QByteArray fromBytes(const perun::Bytes &b) {
  return QByteArray(reinterpret_cast<const char *>(b.data()),
                    static_cast<int>(b.size()));
}

constexpr int kChunkBudget = 100000;
constexpr int kBlobTimeoutMs = 8000;
const char *const kUserAgent = "Perun/1.5 (+https://github.com/vpavlin/perun)";

// A plausible synthetic run near Brno — stand-in for the mobile app's capture.
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

void PerunCoreImpl::onContextReady() {
  m_hub = qEnvironmentVariableIsSet("PERUN_HUB");
  m_deviceId = qEnvironmentVariableIsSet("PERUN_DEVICE_ID")
                   ? qEnvironmentVariable("PERUN_DEVICE_ID")
                   : QStringLiteral("perun-desktop");
  logEvent(std::string("onContextReady — hub=") + (m_hub ? "1" : "0") +
           " device=" + m_deviceId.toStdString());
  m_clock = std::make_unique<logos_sync::Clock>(m_deviceId.toStdString());
  openStoreAndLoad();
  loadOrCreateSecret();
  setStatusStr(QStringLiteral("Starting node…"));
  QTimer::singleShot(0, [this]() { bootstrap(); });
  if (m_hub)
    startHubTimer();
}

void PerunCoreImpl::setStatusStr(const QString &s) {
  m_status = s;
  statusChanged(s.toStdString());
}

void PerunCoreImpl::applyIdentity(const perun::Bytes &secret) {
  m_id = perun::deriveIdentity(secret);
  m_topic = QString::fromStdString(perun::topicFor(m_id));
  m_fingerprintStr = QString::fromStdString(m_id.fpWords[0]) + " " +
                     QString::fromStdString(m_id.fpWords[1]) + " " +
                     QString::fromStdString(m_id.fpWords[2]);
  m_pairingUri = QString::fromStdString(perun::pairingUri(secret));
  logEvent("pairing fingerprint: " + m_fingerprintStr.toStdString());
}

void PerunCoreImpl::loadOrCreateSecret() {
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

void PerunCoreImpl::openStoreAndLoad() {
  // PERUN_CORE_DATA wins (the hub sets it, kym-style). Otherwise a STABLE,
  // module-independent location ($XDG_DATA_HOME/perun) — NOT Basecamp's per-module
  // AppDataLocation, which the core/view split moved and so lost the user's runs +
  // pairing (vpavlin, 2026-08-25). Runs are local data and must survive updates.
  QString dir;
  if (qEnvironmentVariableIsSet("PERUN_CORE_DATA")) {
    dir = qEnvironmentVariable("PERUN_CORE_DATA");
  } else {
    dir = QString::fromLocal8Bit(qgetenv("XDG_DATA_HOME"));
    if (dir.isEmpty())
      dir = QDir::homePath() + QStringLiteral("/.local/share");
    dir += QStringLiteral("/perun");
  }
  m_dataDir = dir;
  QDir().mkpath(m_dataDir);
  migrateLegacyDataIfEmpty(); // adopt an existing store if this one is empty
  logEvent("data dir = " + m_dataDir.toStdString());

  if (!m_store.open((m_dataDir + QStringLiteral("/runs.db")).toStdString())) {
    logEvent("run store open failed");
    return;
  }
  for (const std::string &j : m_store.loadAll()) {
    QJsonParseError err{};
    const QJsonDocument doc =
        QJsonDocument::fromJson(QByteArray::fromStdString(j), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
      continue;
    QJsonObject run = doc.object();
    // Recompute analytics from the stored GPX so runs ingested before an analytics
    // change show corrected numbers with no re-sync.
    const QString id = run.value(QStringLiteral("id")).toString();
    const std::string gz = m_store.getGpx(id.toStdString());
    if (!gz.empty()) {
      try {
        const perun::Track tr = perun::fromGpx(
            perun::gunzip(QByteArray(gz.data(), static_cast<int>(gz.size()))));
        run = runToJson(id, run.value(QStringLiteral("rev")).toInt(1), tr);
      } catch (const std::exception &e) {
        logEvent(std::string("reanalyse on load failed: ") + e.what());
      }
    }
    m_runs.append(run);
  }
  logEvent("loaded " + std::to_string(m_runs.size()) + " persisted runs");
  if (!m_runs.isEmpty())
    publishRuns();

  loadAnnotations();
  loadBlobConfig();
}

// Recover the user's runs when this data dir is empty but a legacy perun store
// exists elsewhere on disk (the old ui_qml module's AppDataLocation, a prior split,
// a Basecamp per-module path). Copies runs.db + pair.key + blob config + sealed blobs
// so runs AND the original pairing come back. Best-effort; runs once.
void PerunCoreImpl::migrateLegacyDataIfEmpty() {
  if (QFileInfo::exists(m_dataDir + QStringLiteral("/runs.db")))
    return; // already have a store — never clobber it

  QStringList roots;
  const QString appData = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
  if (!appData.isEmpty())
    roots << appData;
  roots << QDir::homePath() + QStringLiteral("/.local/share");
  roots << QDir::homePath() + QStringLiteral("/.config");

  QString best;
  qint64 bestSize = -1;
  QSet<QString> seen;
  for (const QString &root : roots) {
    if (root.isEmpty() || seen.contains(root) || !QFileInfo::exists(root))
      continue;
    seen.insert(root);
    QDirIterator it(root, QStringList{QStringLiteral("runs.db")}, QDir::Files,
                    QDirIterator::Subdirectories);
    while (it.hasNext()) {
      const QString f = it.next();
      const QString d = QFileInfo(f).absolutePath();
      if (d == m_dataDir || !d.contains(QLatin1String("perun")))
        continue; // only perun stores, and not ourselves
      const qint64 sz = QFileInfo(f).size();
      if (sz > bestSize) { bestSize = sz; best = d; }
    }
  }
  if (best.isEmpty())
    return;

  logEvent("migrating legacy perun store from " + best.toStdString());
  for (const QString &n : {QStringLiteral("runs.db"), QStringLiteral("pair.key"),
                           QStringLiteral("blob.json")}) {
    const QString src = best + QStringLiteral("/") + n;
    if (QFileInfo::exists(src))
      QFile::copy(src, m_dataDir + QStringLiteral("/") + n);
  }
  const QString sb = best + QStringLiteral("/blobs");
  if (QFileInfo::exists(sb)) {
    QDir().mkpath(m_dataDir + QStringLiteral("/blobs"));
    QDirIterator bi(sb, QDir::Files);
    while (bi.hasNext()) {
      const QString f = bi.next();
      QFile::copy(f, m_dataDir + QStringLiteral("/blobs/") + QFileInfo(f).fileName());
    }
  }
}

void PerunCoreImpl::loadBlobConfig() {
  const QString path = m_dataDir + QStringLiteral("/blob.json");
  QFile f(path);
  if (f.open(QIODevice::ReadOnly)) {
    const QJsonObject o = QJsonDocument::fromJson(f.readAll()).object();
    f.close();
    m_blobUrl = o.value(QStringLiteral("url")).toString();
    m_blobToken = o.value(QStringLiteral("token")).toString();
  }
  if (m_blobUrl.isEmpty() && qEnvironmentVariableIsSet("PERUN_BLOB_URL"))
    m_blobUrl = qEnvironmentVariable("PERUN_BLOB_URL");
  if (m_blobToken.isEmpty() && qEnvironmentVariableIsSet("PERUN_BLOB_TOKEN"))
    m_blobToken = qEnvironmentVariable("PERUN_BLOB_TOKEN");
  while (m_blobUrl.endsWith('/'))
    m_blobUrl.chop(1);
  if (!m_blobUrl.isEmpty())
    logEvent("blob server = " + m_blobUrl.toStdString());
  startBlobServer();
}

QString PerunCoreImpl::blobStoreDir() const {
  return m_dataDir + QStringLiteral("/blobs");
}

void PerunCoreImpl::startBlobServer() {
  quint16 port = 8087;
  if (qEnvironmentVariableIsSet("PERUN_BLOB_PORT")) {
    bool ok = false;
    const int p = qEnvironmentVariable("PERUN_BLOB_PORT").toInt(&ok);
    if (ok && p > 0 && p < 65536)
      port = static_cast<quint16>(p);
  }
  m_blobServer = new PerunBlobServer(blobStoreDir(), port, m_blobToken, nullptr);
  QObject::connect(m_blobServer, &PerunBlobServer::stored,
                   [](const QString &id) { logEvent("blob received " + id.toStdString()); });
  if (m_blobServer->start()) {
    m_blobServerUrl = m_blobServer->url();
    logEvent("blob hub listening at " + m_blobServerUrl.toStdString());
  } else {
    logEvent("blob hub failed to listen");
  }
}

void PerunCoreImpl::loadAnnotations() {
  int n = 0;
  for (const std::string &j : m_store.loadAnnotations()) {
    const QJsonDocument doc = QJsonDocument::fromJson(QByteArray::fromStdString(j));
    if (!doc.isObject())
      continue;
    if (applyAnnotation(doc.object(), /*persist=*/false))
      ++n;
  }
  logEvent("loaded " + std::to_string(n) + " persisted annotations");
  publishAnnotations();
}

// Recover + dispatch one sealed CHUNK/ANNOTATION envelope, regardless of transport
// or base64 depth (SDS reliable-channel wire is DOUBLE-base64, legacy relay single).
void PerunCoreImpl::ingestSealed(const QByteArray &raw) {
  logEvent("rx ingest raw=" + std::to_string(raw.size()) + "B");
  const QByteArray d1 = QByteArray::fromBase64(raw);
  const QByteArray d2 = QByteArray::fromBase64(d1);
  for (const QByteArray &cand : {raw, d1, d2}) {
    if (cand.isEmpty())
      continue;
    bool ok = false;
    const perun::Bytes pt =
        perun::open(m_id, toBytes(cand), m_topic.toStdString(), &ok);
    if (!ok)
      continue;
    QJsonParseError err{};
    const QJsonDocument doc = QJsonDocument::fromJson(fromBytes(pt), &err);
    if (err.error != QJsonParseError::NoError || !doc.isObject())
      return;
    const QJsonObject env = doc.object();
    const QString etype = env.value(QStringLiteral("type")).toString();
    logEvent("rx opened type=" + etype.toStdString());

    if (etype == QLatin1String("ANNOTATION")) {
      const QJsonObject a = env.value(QStringLiteral("a")).toObject();
      if (applyAnnotation(a, /*persist=*/true))
        publishAnnotations();
      return;
    }

    // RBSR catch-up control frame (fp/ids/need). Reconciles the annotation log.
    if (etype == QLatin1String("SYNC_REQ")) {
      const QJsonObject msgObj = env.value(QStringLiteral("msg")).toObject();
      const std::string s =
          QString::fromUtf8(QJsonDocument(msgObj).toJson(QJsonDocument::Compact)).toStdString();
      nlohmann::json msg = nlohmann::json::parse(s, nullptr, false);
      if (msg.is_object())
        onSyncReq(msg);
      return;
    }

    if (etype != QLatin1String("CHUNK"))
      return;

    const QString id = env.value(QStringLiteral("id")).toString();
    const int rev = env.value(QStringLiteral("rev")).toInt(1);
    const int seq = env.value(QStringLiteral("seq")).toInt();
    const int total = env.value(QStringLiteral("total")).toInt();
    const QByteArray part = QByteArray::fromBase64(
        env.value(QStringLiteral("gz")).toString().toLatin1());

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
    return;
  }
  logEvent("rx UNOPENED raw=" + std::to_string(raw.size()) +
           "B (no candidate authenticated — wrong key/topic or base64 depth)");
}

void PerunCoreImpl::bootstrap() {
  // loam_core's CORE proxy is std::string-typed + async (per-event onX subscribers,
  // *Async mutators) — unlike the QString/Qt proxy the ui_qml backend used. onReceived
  // hands the payload as base64 TEXT of the once-decoded sealed bytes; feed it to
  // ingestSealed (which peels raw/single/double-base64) exactly as the old path did.
  modules().loam_core.onReceived(
      [this](const std::string &, const std::string &, const std::string &payloadB64, int64_t) {
        logEvent("rx frame from loam_core");
        m_rxFrames++;
        m_lastRxMs = nowMs();
        ingestSealed(QByteArray::fromStdString(payloadB64));
      });

  modules().loam_core.onStatusChanged([this](const std::string &s) {
    if (s == "Connected" && !m_nodeReady) {
      m_nodeReady = true;
      modules().loam_core.joinAsync(m_topic.toStdString(), [](std::string) {});
      m_ready = true;
      setStatusStr(QStringLiteral("Connected · paired"));
      logEvent("node ready; joined topic hash=" +
               QString::fromLatin1(QCryptographicHash::hash(m_topic.toUtf8(),
                   QCryptographicHash::Sha256).toHex().left(10)).toStdString());
      catchupLadder(); // RBSR: reconcile the annotation log (mesh forms over ~10s)
      QTimer *mt = new QTimer();
      QObject::connect(mt, &QTimer::timeout, [this]() {
        modules().loam_core.metricsJsonAsync([this](std::string mj) {
          m_lastMetrics = QString::fromStdString(mj);
          logEvent("metrics: " + mj.substr(0, std::min<size_t>(mj.size(), 600)));
        });
      });
      mt->start(15000);
      if (qEnvironmentVariableIsSet("PERUN_TEST_AUTOPUBLISH")) {
        logEvent("PERUN_TEST_AUTOPUBLISH set — publishing a sample run in 12s");
        QTimer::singleShot(12000, [this]() { publishSampleRun(); });
      }
    } else if (m_nodeReady) {
      setStatusStr(QString::fromStdString(s));
    }
  });

  // FLEET = logos.test (cluster 2). Matches kym_core's proven createNode shape for the
  // custom Reliable-Channels delivery (8ad99f10): {mode, preset, entryNodes:[...]} — this
  // delivery's parser REJECTS `messagingOverrides` (the old v0.1.3/v0.2.0 shape) and accepts
  // TOP-LEVEL entryNodes (the 6 logos.test fleet nodes) as explicit bootstrap peers, which is
  // what actually meshes the node reliably (preset discv5 alone peer-drops). A standalone hub
  // adds tcpPort/discv5UdpPort via PERUN_DELIVERY_CFG (camelCase, this delivery's schema); the
  // crib shares one node (first createNode wins) so the cores need no per-core ports there.
  // useChannels/hubMode are loam-only flags loam_core strips before forwarding the rest.
  QJsonArray entryNodes{
      "/dns4/node-01.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmQ9X2xDfPG3uL77V9piYDhjq14JhKCtcmNYsTMKNqrKCj",
      "/dns4/node-02.do-ams3.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmB8NYprrfQrgWVzsJtYWkfjsXbmJEGNMG6othXsQ53BwG",
      "/dns4/node-01.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmF8WtwGPmeGHgYAX2277jHgy5cW9F7zsB8EqUjBZQAZQ3",
      "/dns4/node-02.gc-us-central1-a.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmUuXhUW9bdJpzN1kfDziFiUZo4bszTk66cvr7uuyCHXR7",
      "/dns4/node-01.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAmL3oU95jh1BZHozn3uNhx8HEneirgr8M1jEAapzXGDqRF",
      "/dns4/node-02.ac-cn-hongkong-c.logos.test.status.im/tcp/30303/p2p/16Uiu2HAm28CoBZjpyxsanC8tQpbvZ7bZJnVYuB1EgFzb571qpWsV"};
  QJsonObject cfg{
      {"mode", "Core"},
      {"preset", "logos.test"},
      {"relay", true},
      {"entryNodes", entryNodes},
      {"useChannels", true},
      {"hubMode", m_hub}};
  // Diagnostic override, merged over the default (top-level keys), no rebuild — the
  // hub uses this to inject explicit entryNodes/relay for its always-on node.
  if (qEnvironmentVariableIsSet("PERUN_DELIVERY_CFG")) {
    const QJsonObject ov =
        QJsonDocument::fromJson(qEnvironmentVariable("PERUN_DELIVERY_CFG").toUtf8()).object();
    for (auto it = ov.begin(); it != ov.end(); ++it)
      cfg[it.key()] = it.value();
  }
  const QString cfgJson =
      QString::fromUtf8(QJsonDocument(cfg).toJson(QJsonDocument::Compact));
  logEvent("bootstrap cfg=" + cfgJson.toStdString());

  modules().loam_core.setSenderIdAsync(m_deviceId.toStdString(), [](std::string) {});
  modules().loam_core.startAsync(cfgJson.toStdString(), [](std::string err) {
    if (!err.empty())
      logEvent("loam_core.start returned: " + err);
  });
}

std::string PerunCoreImpl::publishSampleRun() {
  if (!m_nodeReady)
    return "Node not ready";
  const int n = m_runs.size() + 1;
  perun::Track tr = makeSyntheticTrack(/*seconds=*/1200, /*hz=*/1);
  tr.name = QStringLiteral("Morning run %1").arg(n).toStdString();
  const QByteArray gz = perun::gzip(perun::toGpx(tr));
  const QString runId = QStringLiteral("run-%1-%2").arg(nowMs()).arg(n);
  const QString err = sendChunks(runId, /*rev=*/1, gz);
  if (!err.isEmpty())
    return err.toStdString();
  ingestGzTrack(runId, /*rev=*/1, gz); // local echo
  return "";
}

QString PerunCoreImpl::sendChunks(const QString &runId, int rev,
                                  const QByteArray &gz) {
  const int total = std::max(
      1, static_cast<int>((gz.size() + kChunkBudget - 1) / kChunkBudget));
  for (int seq = 0; seq < total; ++seq) {
    const QByteArray part = gz.mid(seq * kChunkBudget, kChunkBudget);
    const QJsonObject env{
        {"v", 3}, {"type", "CHUNK"}, {"id", runId}, {"rev", rev}, {"seq", seq},
        {"total", total}, {"gz", QString::fromLatin1(part.toBase64())}};
    const std::string sealId =
        runId.toStdString() + "|" + std::to_string(rev) + "|" + std::to_string(seq);
    const QByteArray sealed = fromBytes(perun::seal(
        m_id, sealId, toBytes(QJsonDocument(env).toJson(QJsonDocument::Compact)),
        m_topic.toStdString()));
    modules().loam_core.sendSealedAsync(
        m_topic.toStdString(), sealed.toBase64().toStdString(),
        [](std::string e) { if (!e.empty()) logEvent("send chunk failed: " + e); });
  }
  logEvent("published " + std::to_string(total) + " chunk(s), " +
           std::to_string(gz.size()) + "B gz for " + runId.toStdString());
  return QString();
}

void PerunCoreImpl::ingestGzTrack(const QString &runId, int rev,
                                  const QByteArray &gz) {
  try {
    const perun::Track tr = perun::fromGpx(perun::gunzip(gz));
    addRun(runToJson(runId, rev, tr), QByteArray(gz.constData(), gz.size()));
  } catch (const std::exception &e) {
    logEvent(std::string("ingest failed: ") + e.what());
  }
}

QJsonObject PerunCoreImpl::runToJson(const QString &runId, int rev,
                                     const perun::Track &tr) const {
  const perun::RunSummary s = perun::computeSummary(tr);
  const std::vector<perun::Split> splits = perun::computeSplits(tr);
  QJsonObject run{
      {"id", runId}, {"rev", rev},
      {"name", QString::fromStdString(tr.name)},
      {"sport", QString::fromStdString(tr.sport)},
      {"category", QString::fromStdString(tr.category)},
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

void PerunCoreImpl::addRun(const QJsonObject &run, const QByteArray &gz) {
  const QString id = run.value(QStringLiteral("id")).toString();
  if (id.isEmpty())
    return;
  const int rev = run.value(QStringLiteral("rev")).toInt(1);
  int existing = -1;
  for (int i = 0; i < m_runs.size(); ++i)
    if (m_runs.at(i).toObject().value(QStringLiteral("id")).toString() == id) {
      existing = i;
      break;
    }
  if (existing >= 0) {
    const int storedRev = m_runs.at(existing).toObject().value(QStringLiteral("rev")).toInt(1);
    if (rev <= storedRev)
      return;
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

void PerunCoreImpl::publishRuns() {
  const QString j = QString::fromUtf8(
      QJsonDocument(m_runs).toJson(QJsonDocument::Compact));
  runsChanged(j.toStdString());
}

bool PerunCoreImpl::applyAnnotation(const QJsonObject &a, bool persist) {
  const QString id = a.value(QStringLiteral("id")).toString();
  const QString runId = a.value(QStringLiteral("runId")).toString();
  const QString kind = a.value(QStringLiteral("kind")).toString();
  if (id.isEmpty() || runId.isEmpty())
    return false;
  trackAnnEvent(a); // record the raw event for RBSR (all kinds incl edit/delete)

  auto doPersist = [&]() {
    if (!persist)
      return;
    const QByteArray j = QJsonDocument(a).toJson(QJsonDocument::Compact);
    m_store.upsertAnnotation(
        id.toStdString(), runId.toStdString(),
        static_cast<int64_t>(a.value(QStringLiteral("t")).toDouble()),
        std::string(j.constData(), static_cast<size_t>(j.size())));
  };

  if (kind == QLatin1String("delete")) {
    const QString target = a.value(QStringLiteral("target")).toString();
    if (target.isEmpty())
      return false;
    QSet<QString> &dels = m_annDeleted[runId];
    const bool tombNew = !dels.contains(target);
    dels.insert(target);
    const bool had = m_annotations[runId].remove(target) > 0;
    doPersist();
    return tombNew || had;
  }

  if (kind == QLatin1String("edit")) {
    const QString target = a.value(QStringLiteral("target")).toString();
    if (target.isEmpty())
      return false;
    const double cAt = a.value(QStringLiteral("createdAt")).toDouble();
    QMap<QString, QJsonObject> &edits = m_annEdits[runId];
    const bool newer = !edits.contains(target) ||
        cAt > edits.value(target).value(QStringLiteral("createdAt")).toDouble();
    if (newer)
      edits.insert(target, a);
    doPersist();
    if (newer)
      applyEditToTarget(runId, target);
    return newer;
  }

  if (m_annDeleted.value(runId).contains(id))
    return false;
  if (m_annotations.value(runId).contains(id))
    return false;
  m_annotations[runId].insert(id, a);
  applyEditToTarget(runId, id);
  doPersist();
  return true;
}

void PerunCoreImpl::applyEditToTarget(const QString &runId, const QString &target) {
  if (!m_annEdits.value(runId).contains(target))
    return;
  if (!m_annotations.value(runId).contains(target))
    return;
  QJsonObject obj = m_annotations[runId].value(target);
  obj.insert(QStringLiteral("text"),
             m_annEdits[runId].value(target).value(QStringLiteral("text")));
  m_annotations[runId].insert(target, obj);
}

void PerunCoreImpl::publishAnnotations() {
  QJsonObject out;
  for (auto it = m_annotations.constBegin(); it != m_annotations.constEnd(); ++it) {
    const QMap<QString, QJsonObject> &byId = it.value();
    if (byId.isEmpty())
      continue;
    QList<QJsonObject> list = byId.values();
    std::sort(list.begin(), list.end(), [](const QJsonObject &x, const QJsonObject &y) {
      return x.value(QStringLiteral("t")).toDouble() <
             y.value(QStringLiteral("t")).toDouble();
    });
    QJsonArray arr;
    for (const QJsonObject &o : list)
      arr.append(o);
    out.insert(it.key(), arr);
  }
  const QString j = QString::fromUtf8(QJsonDocument(out).toJson(QJsonDocument::Compact));
  annotationsChanged(j.toStdString());
}

// ---- loam-sync RBSR catch-up ------------------------------------------------

// Record one annotation as a raw logos_sync::Event for reconciliation (all kinds,
// incl edit/delete — the raw log RBSR diffs; the fold above derives display state).
void PerunCoreImpl::trackAnnEvent(const QJsonObject &a) {
  const std::string id = a.value(QStringLiteral("id")).toString().toStdString();
  if (id.empty())
    return;
  logos_sync::Event e;
  e.id = id;
  e.type = "ANNOTATION";
  e.dev = a.value(QStringLiteral("author")).toString().toStdString();
  double wall = a.value(QStringLiteral("createdAt")).toDouble();
  if (wall <= 0) wall = a.value(QStringLiteral("t")).toDouble();
  e.hlc.wall = static_cast<long long>(wall);
  e.hlc.ctr = 0;
  e.hlc.dev = e.dev;
  e.payload = nlohmann::json::parse(
      QJsonDocument(a).toJson(QJsonDocument::Compact).toStdString(), nullptr, false);
  m_annRaw[id] = e;
  if (m_clock)
    m_clock->receive(e.hlc);
}

std::vector<logos_sync::Event> PerunCoreImpl::annEventsVec() const {
  std::vector<logos_sync::Event> v;
  v.reserve(m_annRaw.size());
  for (const auto &kv : m_annRaw)
    v.push_back(kv.second);
  return v;
}

// Publish our annotation-log fingerprint (buildInitial) as a SYNC_REQ frame. A peer
// (esp. the always-on hub) responds with the events we're missing. Ephemeral seal id
// so requests aren't deduped by the deterministic-nonce store.
void PerunCoreImpl::sendSyncReq() {
  if (!m_nodeReady)
    return;
  nlohmann::json msg = logos_sync::catchup::buildInitial(annEventsVec(), m_deviceId.toStdString());
  nlohmann::json env{{"v", 1}, {"type", "SYNC_REQ"}, {"msg", msg}};
  const std::string sealId =
      "sync|" + QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
  const QByteArray sealed = fromBytes(perun::seal(
      m_id, sealId, toBytes(QByteArray::fromStdString(env.dump())), m_topic.toStdString()));
  modules().loam_core.sendSealedAsync(m_topic.toStdString(), sealed.toBase64().toStdString(),
                                      [](std::string) {});
}

// Respond to an incoming fp/ids/need: serve the annotations the peer lacks (over the
// normal ANNOTATION wire, deterministic seal → dedups) + publish any range replies.
void PerunCoreImpl::onSyncReq(const nlohmann::json &msg) {
  const auto step = logos_sync::catchup::respond(annEventsVec(), msg, m_deviceId.toStdString());
  for (const auto &e : step.serve) {
    const QJsonObject a =
        QJsonDocument::fromJson(QByteArray::fromStdString(e.payload.dump())).object();
    const QJsonObject env{{"v", 1}, {"type", "ANNOTATION"}, {"a", a}};
    const std::string sealId = "ann|" + e.id; // deterministic → idempotent redelivery
    const QByteArray sealed = fromBytes(perun::seal(
        m_id, sealId, toBytes(QJsonDocument(env).toJson(QJsonDocument::Compact)),
        m_topic.toStdString()));
    modules().loam_core.sendSealedAsync(m_topic.toStdString(), sealed.toBase64().toStdString(),
                                        [](std::string) {});
  }
  for (const auto &r : step.replies) {
    nlohmann::json env{{"v", 1}, {"type", "SYNC_REQ"}, {"msg", r}};
    const std::string sealId =
        "sync|" + QUuid::createUuid().toString(QUuid::WithoutBraces).toStdString();
    const QByteArray sealed = fromBytes(perun::seal(
        m_id, sealId, toBytes(QByteArray::fromStdString(env.dump())), m_topic.toStdString()));
    modules().loam_core.sendSealedAsync(m_topic.toStdString(), sealed.toBase64().toStdString(),
                                        [](std::string) {});
  }
  if (!step.serve.empty() || !step.replies.empty())
    logEvent("catchup: served " + std::to_string(step.serve.size()) + " reply " +
             std::to_string(step.replies.size()));
}

// Re-publish our fingerprint at 0/3/10/25s after Connected — the fleet mesh takes
// ~10s to form, and a single early request is lost (scala's ladder, ADR 0004).
void PerunCoreImpl::catchupLadder() {
  sendSyncReq();
  for (int ms : {3000, 10000, 25000})
    QTimer::singleShot(ms, [this]() {
      if (m_nodeReady)
        sendSyncReq();
    });
}

std::string PerunCoreImpl::configureBlobServer(std::string url, std::string token) {
  QString u = QString::fromStdString(url);
  while (u.endsWith('/'))
    u.chop(1);
  m_blobUrl = u;
  m_blobToken = QString::fromStdString(token);
  const QJsonObject o{{"url", m_blobUrl}, {"token", m_blobToken}};
  QSaveFile out(m_dataDir + QStringLiteral("/blob.json"));
  if (out.open(QIODevice::WriteOnly)) {
    out.write(QJsonDocument(o).toJson(QJsonDocument::Compact));
    out.commit();
    QFile::setPermissions(out.fileName(),
                          QFileDevice::ReadOwner | QFileDevice::WriteOwner);
  }
  logEvent("blob server set to " + m_blobUrl.toStdString());
  return "";
}

QByteArray PerunCoreImpl::fetchSealedBlob(const QString &blobId) {
  if (m_blobUrl.isEmpty())
    return {};
  if (!m_net)
    m_net = new QNetworkAccessManager();
  const QString url = m_blobUrl + QStringLiteral("/blob/") + blobId;
  QNetworkRequest req{QUrl(url)};
  req.setHeader(QNetworkRequest::UserAgentHeader, QString::fromLatin1(kUserAgent));
  req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                   QNetworkRequest::NoLessSafeRedirectPolicy);
  if (!m_blobToken.isEmpty())
    req.setRawHeader("Authorization", ("Bearer " + m_blobToken).toUtf8());

  QNetworkReply *reply = m_net->get(req);
  QEventLoop loop;
  QTimer timer;
  timer.setSingleShot(true);
  QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
  QObject::connect(&timer, &QTimer::timeout, &loop, &QEventLoop::quit);
  timer.start(kBlobTimeoutMs);
  loop.exec();
  const bool ok = timer.isActive() && reply->isFinished() &&
                  reply->error() == QNetworkReply::NoError;
  const QByteArray data = ok ? reply->readAll() : QByteArray();
  reply->abort();
  reply->deleteLater();
  if (!ok)
    logEvent("blob GET failed " + blobId.toStdString());
  return data;
}

std::string PerunCoreImpl::getMedia(std::string blobId, std::string mime) {
  (void)mime; // the view picks the extension; the core just returns bytes
  const QString id = QString::fromStdString(blobId);
  static const QRegularExpression kHex(QStringLiteral("^[0-9a-f]{64}$"));
  if (!kHex.match(id).hasMatch())
    return "";

  // Local-first: the embedded hub holds the sealed bytes for anything a phone
  // uploaded to us (or we fetched before) — decrypt with no network.
  QByteArray sealed;
  const QString sealedPath = blobStoreDir() + QStringLiteral("/") + id;
  if (QFileInfo::exists(sealedPath)) {
    QFile sf(sealedPath);
    if (sf.open(QIODevice::ReadOnly))
      sealed = sf.readAll();
  }
  if (sealed.isEmpty())
    sealed = fetchSealedBlob(id);
  if (sealed.isEmpty())
    return "";

  bool ok = false;
  const perun::Bytes pt =
      perun::open(m_id, toBytes(sealed), m_topic.toStdString(), &ok);
  if (!ok) {
    logEvent("getMedia decrypt failed " + blobId);
    return "";
  }
  return fromBytes(pt).toBase64().toStdString();
}

std::string PerunCoreImpl::addAnnotation(std::string json) {
  if (!m_nodeReady)
    return "Node not ready";
  const QJsonObject in = QJsonDocument::fromJson(
      QByteArray::fromStdString(json)).object();
  const QString runId = in.value(QStringLiteral("runId")).toString();
  const QString text = in.value(QStringLiteral("text")).toString();
  if (runId.isEmpty() || text.trimmed().isEmpty())
    return "runId and text required";

  const QString id = QUuid::createUuid().toString(QUuid::WithoutBraces);
  const qint64 created = nowMs();
  const bool eleValid = in.value(QStringLiteral("eleValid")).toBool();
  const double t = in.value(QStringLiteral("t")).toDouble();
  QJsonObject a{
      {"id", id}, {"runId", runId},
      {"lat", in.value(QStringLiteral("lat")).toDouble()},
      {"lon", in.value(QStringLiteral("lon")).toDouble()},
      {"ele", eleValid ? QJsonValue(in.value(QStringLiteral("ele")).toDouble())
                       : QJsonValue(QJsonValue::Null)},
      {"t", t > 0 ? t : static_cast<double>(created)},
      {"createdAt", static_cast<double>(created)},
      {"author", m_deviceId},
      {"kind", "text"}, {"text", text}};
  const QJsonObject env{{"v", 1}, {"type", "ANNOTATION"}, {"a", a}};

  const std::string sealId = "ann|" + id.toStdString();
  const QByteArray sealed = fromBytes(perun::seal(
      m_id, sealId, toBytes(QJsonDocument(env).toJson(QJsonDocument::Compact)),
      m_topic.toStdString()));
  modules().loam_core.sendSealedAsync(
      m_topic.toStdString(), sealed.toBase64().toStdString(),
      [](std::string e) { if (!e.empty()) logEvent("send annotation failed: " + e); });
  if (applyAnnotation(a, /*persist=*/true))
    publishAnnotations();
  logEvent("authored text annotation " + id.toStdString() + " for " +
           runId.toStdString());
  return "";
}

std::string PerunCoreImpl::trackJson(std::string runId) {
  const std::string gzs = m_store.getGpx(runId);
  if (gzs.empty())
    return "[]";
  try {
    const perun::Track tr = perun::fromGpx(
        perun::gunzip(QByteArray(gzs.data(), static_cast<int>(gzs.size()))));
    QJsonArray pts;
    for (const auto &p : tr.points)
      pts.append(QJsonObject{{"lat", p.lat}, {"lon", p.lon}, {"alt", p.alt},
                             {"altValid", p.altValid}, {"hr", p.hr},
                             {"t", static_cast<qint64>(p.t)}, {"brk", p.brk}});
    return QString::fromUtf8(QJsonDocument(pts).toJson(QJsonDocument::Compact))
        .toStdString();
  } catch (const std::exception &e) {
    logEvent(std::string("trackJson failed: ") + e.what());
    return "[]";
  }
}

std::string PerunCoreImpl::exportGpx(std::string runId) {
  const std::string gzs = m_store.getGpx(runId);
  if (gzs.empty())
    return "";
  try {
    const QByteArray gpx =
        perun::gunzip(QByteArray(gzs.data(), static_cast<int>(gzs.size())));
    const QString dir = m_dataDir + QStringLiteral("/exports");
    QDir().mkpath(dir);
    const QString path =
        dir + "/" + QString::fromStdString(runId) + QStringLiteral(".gpx");
    QFile f(path);
    if (!f.open(QIODevice::WriteOnly))
      return "";
    f.write(gpx);
    f.close();
    logEvent("exported " + path.toStdString());
    return path.toStdString();
  } catch (const std::exception &e) {
    logEvent(std::string("exportGpx failed: ") + e.what());
    return "";
  }
}

std::string PerunCoreImpl::resetPairing() {
  const perun::Bytes secret = perun::randomSecret();
  if (secret.size() != 32)
    return "failed to generate secret";
  const QString path = m_dataDir + QStringLiteral("/pair.key");
  QSaveFile out(path);
  if (out.open(QIODevice::WriteOnly)) {
    out.write(fromBytes(secret));
    out.commit();
    QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
  }
  applyIdentity(secret);
  if (m_nodeReady)
    modules().loam_core.joinAsync(m_topic.toStdString(), [](std::string) {});
  logEvent("pairing reset — old phones unpaired");
  return "";
}

std::string PerunCoreImpl::pairWithCode(std::string code) {
  const perun::Bytes secret = perun::decodeSecret(QString::fromStdString(code).toStdString());
  if (secret.size() != 32)
    return "invalid pairing code";
  const QString path = m_dataDir + QStringLiteral("/pair.key");
  QSaveFile out(path);
  if (out.open(QIODevice::WriteOnly)) {
    out.write(fromBytes(secret));
    out.commit();
    QFile::setPermissions(path, QFileDevice::ReadOwner | QFileDevice::WriteOwner);
  }
  applyIdentity(secret);
  if (m_nodeReady)
    modules().loam_core.joinAsync(m_topic.toStdString(), [](std::string) {});
  logEvent("adopted household from pairing code; fingerprint " +
           m_fingerprintStr.toStdString());
  return "";
}

std::string PerunCoreImpl::status() { return m_status.toStdString(); }
std::string PerunCoreImpl::fingerprint() { return m_fingerprintStr.toStdString(); }

std::string PerunCoreImpl::metricsJson() { return m_lastMetrics.toStdString(); }

std::string PerunCoreImpl::snapshot() {
  // Live transport diagnostics — so "connected but no sync" is visible in the UI.
  const QJsonObject metrics =
      QJsonDocument::fromJson(m_lastMetrics.toUtf8()).object();
  long long peers = metrics.value(QStringLiteral("peers")).toInt(-1);
  long long wireRx = 0, wireTx = 0, blePeers = 0;
  for (const QJsonValue &bv : metrics.value(QStringLiteral("bearers")).toArray()) {
    const QJsonObject b = bv.toObject();
    const QString name = b.value(QStringLiteral("name")).toString();
    if (name == QLatin1String("delivery")) {
      wireRx = b.value(QStringLiteral("rx")).toInt();
      wireTx = b.value(QStringLiteral("tx")).toInt();
      if (peers < 0) peers = b.value(QStringLiteral("peers")).toInt(-1);
    } else if (name == QLatin1String("ble")) {
      blePeers = b.value(QStringLiteral("peers")).toInt();
    }
  }
  const QJsonObject diag{
      {"deviceId", m_deviceId},
      {"hub", m_hub},
      {"nodeReady", m_nodeReady},
      {"peers", static_cast<double>(peers)},   // -1 = metrics not yet in
      {"blePeers", static_cast<double>(blePeers)},
      {"wireRx", static_cast<double>(wireRx)},  // frames the delivery node saw
      {"wireTx", static_cast<double>(wireTx)},
      {"rxFrames", static_cast<double>(m_rxFrames)}, // frames that reached perun_core
      {"lastRxAgoS", m_lastRxMs > 0
                         ? static_cast<double>((nowMs() - m_lastRxMs) / 1000)
                         : -1.0},
      {"annEvents", static_cast<double>(m_annRaw.size())},
      {"topicHash", QString::fromLatin1(QCryptographicHash::hash(
                        m_topic.toUtf8(), QCryptographicHash::Sha256)
                        .toHex()
                        .left(10))},
  };

  QJsonObject out{
      {"status", m_status},
      {"ready", m_ready},
      {"fingerprint", m_fingerprintStr},
      {"pairingUri", m_pairingUri},
      {"runs", m_runs},
      {"blobServer", m_blobUrl},
      {"blobServerUrl", m_blobServerUrl},
      {"diag", diag},
  };
  QJsonObject anns;
  for (auto it = m_annotations.constBegin(); it != m_annotations.constEnd(); ++it) {
    const QMap<QString, QJsonObject> &byId = it.value();
    if (byId.isEmpty())
      continue;
    QList<QJsonObject> list = byId.values();
    std::sort(list.begin(), list.end(), [](const QJsonObject &x, const QJsonObject &y) {
      return x.value(QStringLiteral("t")).toDouble() <
             y.value(QStringLiteral("t")).toDouble();
    });
    QJsonArray arr;
    for (const QJsonObject &o : list)
      arr.append(o);
    anns.insert(it.key(), arr);
  }
  out.insert(QStringLiteral("annotations"), anns);
  return QString::fromUtf8(QJsonDocument(out).toJson(QJsonDocument::Compact))
      .toStdString();
}

// ---- Hub mode ----

void PerunCoreImpl::startHubTimer() {
  m_hubTimer = new QTimer();
  QObject::connect(m_hubTimer, &QTimer::timeout, [this]() { writeHubHeartbeat(); });
  m_hubTimer->setInterval(10000);
  // First beat once delivery has had a moment to come up.
  QTimer::singleShot(5000, m_hubTimer, [this]() {
    writeHubHeartbeat();
    m_hubTimer->start();
  });
  logEvent("hub timer armed (heartbeat → " +
           (m_dataDir + "/hub.json").toStdString() + ")");
}

void PerunCoreImpl::writeHubHeartbeat() {
  if (m_dataDir.isEmpty())
    return;
  auto write = [this]() {
    const QJsonObject o{
        {"status", m_status},
        {"ready", m_ready},
        {"device", m_deviceId},
        {"fingerprint", m_fingerprintStr},
        {"runs", m_runs.size()},
        {"metrics", QJsonDocument::fromJson(m_lastMetrics.toUtf8()).object()},
        {"ts", static_cast<double>(nowMs())},
    };
    QSaveFile f(m_dataDir + QStringLiteral("/hub.json"));
    if (f.open(QIODevice::WriteOnly)) {
      f.write(QJsonDocument(o).toJson(QJsonDocument::Compact));
      f.commit();
    }
  };
  if (m_nodeReady) {
    modules().loam_core.metricsJsonAsync([this, write](std::string m) {
      m_lastMetrics = QString::fromStdString(m);
      write();
    });
  } else {
    write();
  }
}
