#include "perun_analytics_backend.h"

#include <algorithm>
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

#include "blob_server.h"
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QUuid>
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
    if (err.error != QJsonParseError::NoError || !doc.isObject())
      continue;
    QJsonObject run = doc.object();
    // Recompute analytics from the stored GPX blob so runs ingested BEFORE an
    // analytics change (e.g. the elevation-gain fix) show corrected numbers on
    // the next launch — no re-sync needed. Falls back to the stored json if the
    // blob is missing or unparseable.
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

// Blob-server config: persisted <dataDir>/blob.json wins; otherwise fall back to
// env (PERUN_BLOB_URL / PERUN_BLOB_TOKEN). setBlobServer() rewrites the file.
void PerunAnalyticsBackend::loadBlobConfig() {
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
  // Normalise: drop any trailing slash so we can append "/blob/<id>" cleanly.
  while (m_blobUrl.endsWith('/'))
    m_blobUrl.chop(1);
  setBlobServer(m_blobUrl);
  if (!m_blobUrl.isEmpty())
    logEvent("blob server = " + m_blobUrl.toStdString());
  startBlobServer();
}

// Sealed (ciphertext) blob store — the durable content-addressed hub, keyed by
// sha256(sealed) == the mobile "cid". Lives in the data dir (persists; not the
// sandbox tile root). The decrypted display cache is separate (mediaDir()).
QString PerunAnalyticsBackend::blobStoreDir() const {
  return m_dataDir + QStringLiteral("/blobs");
}

// Autostart the embedded content-addressed blob server so the desktop doubles as the
// household media hub. Port from PERUN_BLOB_PORT (default 8087); falls back to an
// OS-assigned port if taken. The mobile app points its attachment URL at blobServerUrl.
void PerunAnalyticsBackend::startBlobServer() {
  quint16 port = 8087;
  if (qEnvironmentVariableIsSet("PERUN_BLOB_PORT")) {
    bool ok = false;
    const int p = qEnvironmentVariable("PERUN_BLOB_PORT").toInt(&ok);
    if (ok && p > 0 && p < 65536)
      port = static_cast<quint16>(p);
  }
  m_blobServer = new PerunBlobServer(blobStoreDir(), port, m_blobToken, this);
  connect(m_blobServer, &PerunBlobServer::stored, this, [this](const QString &id) {
    logEvent("blob received " + id.toStdString());
  });
  if (m_blobServer->start()) {
    setBlobServerUrl(m_blobServer->url());
    logEvent("blob hub listening at " + m_blobServer->url().toStdString());
  } else {
    logEvent("blob hub failed to listen");
  }
}

void PerunAnalyticsBackend::loadAnnotations() {
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

// Recover + dispatch one sealed CHUNK envelope, regardless of transport or
// base64 depth: the SDS reliable-channel wire (phone loam-transport real-node)
// is DOUBLE-base64, legacy plain relay is single. Try the payload raw, single-,
// and double-base64-decoded; the first that authenticates with our pairing key
// wins. Payload is nonce(12) + ChaCha20-Poly1305(env, aad=topic); a bad tag =
// not ours / tampered / wrong candidate -> skip.
void PerunAnalyticsBackend::ingestSealed(const QByteArray &raw) {
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

    // ANNOTATION: photo / voice / text / delete pinned to a journey point,
    // authored on mobile and synced as its own sealed envelope alongside CHUNKs.
    // The payload is the `a` object (shared contract); fold it into the store.
    if (etype == QLatin1String("ANNOTATION")) {
      const QJsonObject a = env.value(QStringLiteral("a")).toObject();
      if (applyAnnotation(a, /*persist=*/true))
        publishAnnotations();
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
    return;
  }
}

void PerunAnalyticsBackend::bootstrap() {
  // Receive + readiness via the loam_core FACADE (ADR 0015; kym/qaku parity).
  // loam_core owns the delivery node + bearer(s), dedups across them, and hands us
  // the payload as base64 of the ONCE-decoded sealed bytes — byte-identical to what
  // perun's OLD channel path received (base64 TEXT of the sealed bytes). We feed it
  // straight into ingestSealed, which keeps its raw/single/double-base64 peel (the
  // phone's loam-transport wire is double-base64, legacy relay single). The two old
  // receive paths (raw relay + SDS channel) collapse into this one `received` event;
  // its payloadB64 is a string, so data.at(2).toByteArray() yields the base64 text.
  auto onSealed = [this](const QVariantList &data) {
    if (data.size() >= 3)
      ingestSealed(data.at(2).toByteArray());
  };
  modules().loam_core.on("received", onSealed);

  // Readiness: loam_core.start() returns early (async node bringup), so the node is
  // actually up only when statusChanged reports "Connected". That replaces the old
  // synchronous createNode→start→subscribe success path: mark ready, join the derived
  // topic (loam_core.join subscribes the content topic + opens the SDS channel with
  // our senderId), surface the paired status, and (test) autopublish.
  modules().loam_core.on("statusChanged", [this](const QVariantList &data) {
    if (data.isEmpty())
      return;
    const QString s = data.at(0).toString();
    if (s == QLatin1String("Connected") && !m_nodeReady) {
      m_nodeReady = true;
      modules().loam_core.join(m_topic);
      setReady(true);
      // Never surface the derived topic (secret-adjacent) — the fingerprint PROP is
      // the user-facing pairing identity.
      setStatus(QStringLiteral("Connected · paired"));
      logEvent("node ready on derived topic");
      if (qEnvironmentVariableIsSet("PERUN_TEST_AUTOPUBLISH")) {
        logEvent("PERUN_TEST_AUTOPUBLISH set — publishing a sample run in 12s");
        QTimer::singleShot(12000, [this]() { publishSampleRun(); });
      }
    } else if (m_nodeReady) {
      setStatus(s);
    }
  });

  // FLEET = logos.test (cluster 2). delivery v0.2.0 uses the LAYERED createNode shape
  // {mode, preset, messagingOverrides:{...}}; the logos.test preset supplies the fleet
  // discv5 bootstrap, so we do NOT pin bare entryNodes (v0.2.0's strict parser rejects
  // top-level WakuNodeConf keys, and discv5-udp-port is REQUIRED or the node stays at 0
  // peers — the same canonical cfg kym/qaku use). useChannels/hubMode are loam-only flags
  // loam_core strips before forwarding the rest to the delivery node verbatim: perun
  // always rides SDS Reliable Channels; hubMode stays false (perun is never a headless hub).
  // Ports are 0 = OS-assigned (ephemeral). Fixed ports (tcp 30303 / discv5 9000) collide
  // with a leftover node from a crashed restart, or another loam_core app on this host —
  // "Address already in use" on START_NODE. A desktop client dials the fleet outbound, so
  // an ephemeral port is fine; the key must still be PRESENT so discv5 starts.
  const QJsonObject cfg{
      {"mode", "Core"},
      {"preset", "logos.test"},
      {"messagingOverrides", QJsonObject{{"logLevel", "INFO"},
                                         {"tcp-port", 0},
                                         {"discv5-udp-port", 0}}},
      {"useChannels", true},
      {"hubMode", qEnvironmentVariableIsSet("PERUN_HUB")}};
  const QString cfgJson =
      QString::fromUtf8(QJsonDocument(cfg).toJson(QJsonDocument::Compact));
  logEvent("bootstrap cfg=" + cfgJson.toStdString());

  // Route the node through the loam_core FACADE. One start() owns createNode+start;
  // readiness arrives via the statusChanged("Connected") handler above, not from here.
  // setSenderId first so join()'s SDS channel uses our id (was channelCreate's
  // "perun-desktop" senderId). Both return a status string ("" ok / error text).
  modules().loam_core.setSenderId(QStringLiteral("perun-desktop"));
  const QString err = modules().loam_core.start(cfgJson);
  if (!err.isEmpty())
    logEvent("loam_core.start returned: " + err.toStdString());
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
    // Deterministic nonce (ADR 0011): a chunk is uniquely identified by
    // run+rev+seq, so re-sending it re-seals byte-identical → the store dedups.
    const std::string sealId =
        runId.toStdString() + "|" + std::to_string(rev) + "|" + std::to_string(seq);
    const QByteArray sealed = fromBytes(perun::seal(
        m_id, sealId, toBytes(QJsonDocument(env).toJson(QJsonDocument::Compact)),
        m_topic.toStdString()));
    // loam_core.sendSealed takes the base64 TEXT of the sealed bytes: it decodes
    // once to the sealed bytes, then its delivery bearer re-encodes + lets delivery
    // add the outer wire layer, preserving the SINGLE-base64 seam the phone expects.
    // Returns a status string ("" ok / error text).
    const QString err =
        modules().loam_core.sendSealed(m_topic, QString::fromLatin1(sealed.toBase64()));
    if (!err.isEmpty()) {
      logEvent("send chunk failed: " + err.toStdString());
      return err;
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

// Fold one annotation `a` object in. Dedup by a.id; kind:"delete" removes its
// target (and remembers it, so a delete that arrives before its target still
// wins). Order-independent, so live ingest and load share this one path.
bool PerunAnalyticsBackend::applyAnnotation(const QJsonObject &a, bool persist) {
  const QString id = a.value(QStringLiteral("id")).toString();
  const QString runId = a.value(QStringLiteral("runId")).toString();
  const QString kind = a.value(QStringLiteral("kind")).toString();
  if (id.isEmpty() || runId.isEmpty())
    return false;

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
    // Record the tombstone (blocks a later-arriving target) and drop it now.
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
    // Keep only the newest edit per target (LWW by createdAt); order-independent, so an
    // edit arriving before its target is remembered and applied when the target lands.
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

  // A non-delete whose id is already tombstoned stays suppressed.
  if (m_annDeleted.value(runId).contains(id))
    return false;
  // Dedup by id (annotations are immutable once authored).
  if (m_annotations.value(runId).contains(id))
    return false;
  m_annotations[runId].insert(id, a);
  applyEditToTarget(runId, id); // a caption edit may have arrived before this photo
  doPersist();
  return true;
}

// Override a target annotation's text with its winning edit, if both are present.
void PerunAnalyticsBackend::applyEditToTarget(const QString &runId, const QString &target) {
  if (!m_annEdits.value(runId).contains(target))
    return;
  if (!m_annotations.value(runId).contains(target))
    return;
  QJsonObject obj = m_annotations[runId].value(target);
  obj.insert(QStringLiteral("text"), m_annEdits[runId].value(target).value(QStringLiteral("text")));
  m_annotations[runId].insert(target, obj);
}

// runId -> [annotations sorted by point time t]. Auto-syncs to QML like runsJson.
void PerunAnalyticsBackend::publishAnnotations() {
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
  setAnnotationsJson(QString::fromUtf8(
      QJsonDocument(out).toJson(QJsonDocument::Compact)));
}

QString PerunAnalyticsBackend::configureBlobServer(QString url, QString token) {
  while (url.endsWith('/'))
    url.chop(1);
  m_blobUrl = url;
  m_blobToken = token;
  // Persist both; token stays out of the surfaced PROP (setBlobServer PROP below).
  const QJsonObject o{{"url", m_blobUrl}, {"token", m_blobToken}};
  QSaveFile out(m_dataDir + QStringLiteral("/blob.json"));
  if (out.open(QIODevice::WriteOnly)) {
    out.write(QJsonDocument(o).toJson(QJsonDocument::Compact));
    out.commit();
    QFile::setPermissions(out.fileName(),
                          QFileDevice::ReadOwner | QFileDevice::WriteOwner);
  }
  setBlobServer(m_blobUrl); // update the READONLY PROP (URL only)
  logEvent("blob server set to " + m_blobUrl.toStdString());
  return QString();
}

// Media cache dir: inside the view sandbox (the tile root) when known, so
// QQuickImage / MediaPlayer can read the decrypted file:// off disk. Falls back
// to the data dir (works for the backend, but sandbox-blocked for the view).
QString PerunAnalyticsBackend::mediaDir() const {
  return (m_tileRoot.isEmpty() ? m_dataDir : m_tileRoot) +
         QStringLiteral("/media");
}

namespace {
// Extension for the decrypted media file from its declared mime.
QString extForMime(const QString &mime) {
  const QString m = mime.toLower();
  if (m.contains(QLatin1String("jpeg")) || m.contains(QLatin1String("jpg")))
    return QStringLiteral("jpg");
  if (m.contains(QLatin1String("png")))
    return QStringLiteral("png");
  if (m.contains(QLatin1String("webp")))
    return QStringLiteral("webp");
  if (m.contains(QLatin1String("m4a")) || m.contains(QLatin1String("mp4")) ||
      m.contains(QLatin1String("aac")))
    return QStringLiteral("m4a");
  if (m.contains(QLatin1String("mpeg")) || m.contains(QLatin1String("mp3")))
    return QStringLiteral("mp3");
  if (m.contains(QLatin1String("ogg")) || m.contains(QLatin1String("opus")))
    return QStringLiteral("ogg");
  if (m.contains(QLatin1String("wav")))
    return QStringLiteral("wav");
  return QStringLiteral("bin");
}
} // namespace

// Decrypt one sealed blob into the sandbox media cache (shared by the local-first
// store path and the remote-fetch path). Returns true if the plaintext was written.
bool PerunAnalyticsBackend::decryptSealedToCache(const QString &blobId,
                                                 const QString &mime,
                                                 const QByteArray &sealed) {
  bool ok = false;
  const perun::Bytes pt =
      perun::open(m_id, toBytes(sealed), m_topic.toStdString(), &ok);
  if (!ok)
    return false;
  const QString dir = mediaDir();
  if (!QDir().mkpath(dir))
    return false;
  const QString path =
      dir + QStringLiteral("/") + blobId + QStringLiteral(".") + extForMime(mime);
  QSaveFile f(path);
  if (!f.open(QIODevice::WriteOnly) || f.write(fromBytes(pt)) < 0 || !f.commit())
    return false;
  return true;
}

QString PerunAnalyticsBackend::loadMedia(QString blobId, QString mime) {
  // Only 64-hex sha256 ids are valid blob ids (also keeps the path safe).
  static const QRegularExpression kHex(QStringLiteral("^[0-9a-f]{64}$"));
  if (!kHex.match(blobId).hasMatch())
    return QString();

  const QString path =
      mediaDir() + QStringLiteral("/") + blobId + QStringLiteral(".") + extForMime(mime);
  const QFileInfo cached(path);
  if (cached.exists() && cached.size() > 0)
    return QUrl::fromLocalFile(path).toString(); // synchronous cache hit

  // Local-first: if we hold the sealed bytes (a phone uploaded them to our embedded
  // hub, or we fetched them before), decrypt them here — no HTTP round-trip.
  const QString sealedPath = blobStoreDir() + QStringLiteral("/") + blobId;
  if (QFileInfo::exists(sealedPath)) {
    QFile sf(sealedPath);
    if (sf.open(QIODevice::ReadOnly)) {
      const QByteArray sealed = sf.readAll();
      if (decryptSealedToCache(blobId, mime, sealed))
        return QUrl::fromLocalFile(path).toString();
    }
  }

  if (m_blobUrl.isEmpty()) {
    emit mediaFailed(blobId, QStringLiteral("blob server not configured"));
    return QString();
  }
  if (!m_mediaInFlight.contains(blobId)) {
    m_mediaInFlight.insert(blobId);
    fetchAndDecryptBlob(blobId, mime);
  }
  return QString(); // async — result via mediaReady/mediaFailed
}

// GET the CIPHERTEXT blob, open() it with the run's pairing identity (the same
// identity/topic that opened this run's CHUNKs), cache the plaintext, emit.
void PerunAnalyticsBackend::fetchAndDecryptBlob(const QString &blobId,
                                                const QString &mime) {
  if (!m_net)
    m_net = new QNetworkAccessManager(this);
  const QString url = m_blobUrl + QStringLiteral("/blob/") + blobId;
  QNetworkRequest req{QUrl(url)};
  req.setHeader(QNetworkRequest::UserAgentHeader,
                QString::fromLatin1(kTileUserAgent));
  req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                   QNetworkRequest::NoLessSafeRedirectPolicy);
  if (!m_blobToken.isEmpty())
    req.setRawHeader("Authorization",
                     ("Bearer " + m_blobToken).toUtf8());

  QNetworkReply *reply = m_net->get(req);
  QObject::connect(reply, &QNetworkReply::finished, this, [this, reply, blobId, mime]() {
    reply->deleteLater();
    m_mediaInFlight.remove(blobId);
    if (reply->error() != QNetworkReply::NoError) {
      logEvent("blob GET failed " + blobId.toStdString() + ": " +
               reply->errorString().toStdString());
      emit mediaFailed(blobId, reply->errorString());
      return;
    }
    const QByteArray sealed = reply->readAll();
    if (m_tileRoot.isEmpty())
      logEvent("media root unset — decrypted media will be sandbox-blocked");
    if (!decryptSealedToCache(blobId, mime, sealed)) {
      logEvent("blob decrypt/cache failed " + blobId.toStdString());
      emit mediaFailed(blobId, QStringLiteral("decrypt failed"));
      return;
    }
    const QString path =
        mediaDir() + QStringLiteral("/") + blobId + QStringLiteral(".") + extForMime(mime);
    logEvent("cached decrypted media " + blobId.toStdString());
    emit mediaReady(blobId, QUrl::fromLocalFile(path).toString());
  });
}

QString PerunAnalyticsBackend::addTextAnnotation(QString runId, double lat,
                                                 double lon, double ele,
                                                 bool eleValid, double t,
                                                 QString text) {
  if (!m_nodeReady)
    return QStringLiteral("Node not ready");
  if (runId.isEmpty() || text.trimmed().isEmpty())
    return QStringLiteral("runId and text required");

  const QString id = QUuid::createUuid().toString(QUuid::WithoutBraces);
  const qint64 created = nowMs();
  QJsonObject a{
      {"id", id},
      {"runId", runId},
      {"lat", lat},
      {"lon", lon},
      {"ele", eleValid ? QJsonValue(ele) : QJsonValue(QJsonValue::Null)},
      {"t", t > 0 ? t : static_cast<double>(created)},
      {"createdAt", static_cast<double>(created)},
      {"author", QStringLiteral("perun-desktop")},
      {"kind", "text"},
      {"text", text}};
  const QJsonObject env{{"v", 1}, {"type", "ANNOTATION"}, {"a", a}};

  // Deterministic nonce (ADR 0011): the annotation id uniquely identifies this
  // immutable payload, so re-sending re-seals byte-identical and the store dedups.
  const std::string sealId = "ann|" + id.toStdString();
  const QByteArray sealed = fromBytes(perun::seal(
      m_id, sealId, toBytes(QJsonDocument(env).toJson(QJsonDocument::Compact)),
      m_topic.toStdString()));
  const QString err =
      modules().loam_core.sendSealed(m_topic, QString::fromLatin1(sealed.toBase64()));
  if (!err.isEmpty()) {
    logEvent("send annotation failed: " + err.toStdString());
    return err;
  }
  // Local echo — the relay won't loop our own message back.
  if (applyAnnotation(a, /*persist=*/true))
    publishAnnotations();
  logEvent("authored text annotation " + id.toStdString() + " for " +
           runId.toStdString());
  return QString();
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
                             // altValid lets the elevation chart skip no-fix
                             // points (which parse to alt=0) instead of drawing
                             // a spike to zero.
                             {"altValid", p.altValid},
                             {"hr", p.hr}, {"t", static_cast<qint64>(p.t)},
                             // The map must not draw across a pause.
                             {"brk", p.brk}});
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

  // Join the new derived topic. loam_core exposes no leave/unsubscribe; join()ing
  // the new topic is enough — messages on the old topic no longer decrypt with the
  // new pairing key, so ingestSealed silently drops them (bad AEAD tag).
  if (m_nodeReady)
    modules().loam_core.join(m_topic);
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
  // The view passes Qt.resolvedUrl(".") — a file:// URL to the dir Main.qml was
  // loaded from, which IS inside the plugin sandbox (that's where the engine
  // loaded the view from in the first place). Tiles cached under it are
  // therefore readable by Image.
  QString path = QUrl(dirUrl).isLocalFile() ? QUrl(dirUrl).toLocalFile() : dirUrl;
  while (path.endsWith('/'))
    path.chop(1);
  m_tileRoot = path;
  // Logged because a wrong root is invisible otherwise — it just looks like
  // "tiles don't work". Compare this against the sandbox root in the ui-host
  // log if tiles are blocked.
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

  // Cache under the sandbox-readable tile root the view gave us. Falling back to
  // the data dir keeps the backend working, but those tiles WILL be blocked by
  // the sandbox — so say so once rather than failing mutely.
  if (m_tileRoot.isEmpty())
    logEvent("tile root unset — tiles will be sandbox-blocked");
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
  if (!f.open(QIODevice::WriteOnly)) {
    logEvent("tile cache write failed (unwritable root?): " + dir.toStdString());
    return QString();
  }
  f.write(data);
  if (!f.commit())
    return QString();

  return QUrl::fromLocalFile(path).toString();
}
