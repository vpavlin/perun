#include "perun_analytics_backend.h"

#include <iostream>

#include <QByteArray>
#include <QDir>
#include <QEventLoop>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QNetworkAccessManager>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QRegularExpression>
#include <QSaveFile>
#include <QStandardPaths>
#include <QTimer>
#include <QUrl>
#include <QVariantList>

#include "logos_sdk.h"
#include "logos_types.h"

#include "qrcodegen.hpp"

namespace {
void logEvent(const std::string &what) {
  std::cerr << "[perun_analytics view] " << what << std::endl;
}

constexpr int kMaxTileZoom = 16;
constexpr int kTileTimeoutMs = 8000;
const char *const kTileUserAgent = "Perun/1.5 (+https://github.com/vpavlin/perun)";

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

void PerunAnalyticsBackend::onContextReady() {
  logEvent("onContextReady — proxying perun_core");
  // Events are a bonus (unreliable on desktop); the poll is the source of truth.
  modules().perun_core.on("runsChanged", [this](const QVariantList &) { refresh(); });
  modules().perun_core.on("annotationsChanged", [this](const QVariantList &) { refresh(); });
  modules().perun_core.on("statusChanged", [this](const QVariantList &) { refresh(); });
  m_poll = new QTimer(this);
  connect(m_poll, &QTimer::timeout, this, [this]() { refresh(); });
  m_poll->start(2000);
  refresh();
}

void PerunAnalyticsBackend::refresh() {
  const QString snap = modules().perun_core.snapshot();
  if (snap.isEmpty())
    return;
  const QJsonObject o = QJsonDocument::fromJson(snap.toUtf8()).object();
  if (o.isEmpty())
    return;
  setStatus(o.value(QStringLiteral("status")).toString());
  setReady(o.value(QStringLiteral("ready")).toBool());
  setFingerprint(o.value(QStringLiteral("fingerprint")).toString());
  setPairingUri(o.value(QStringLiteral("pairingUri")).toString());
  setBlobServer(o.value(QStringLiteral("blobServer")).toString());
  setBlobServerUrl(o.value(QStringLiteral("blobServerUrl")).toString());
  setRunsJson(QString::fromUtf8(QJsonDocument(o.value(QStringLiteral("runs")).toArray())
                                    .toJson(QJsonDocument::Compact)));
  setAnnotationsJson(QString::fromUtf8(
      QJsonDocument(o.value(QStringLiteral("annotations")).toObject())
          .toJson(QJsonDocument::Compact)));
}

// ---- Commands: forward to perun_core, then refresh the mirrored state ----

QString PerunAnalyticsBackend::publishSampleRun() {
  const QString e = modules().perun_core.publishSampleRun();
  refresh();
  return e;
}

QString PerunAnalyticsBackend::trackJson(QString runId) {
  return modules().perun_core.trackJson(runId);
}

QString PerunAnalyticsBackend::exportGpx(QString runId) {
  return modules().perun_core.exportGpx(runId);
}

QString PerunAnalyticsBackend::configureBlobServer(QString url, QString token) {
  const QString e = modules().perun_core.configureBlobServer(url, token);
  refresh();
  return e;
}

QString PerunAnalyticsBackend::resetPairing() {
  const QString e = modules().perun_core.resetPairing();
  refresh();
  return e;
}

QString PerunAnalyticsBackend::addTextAnnotation(QString runId, double lat,
                                                 double lon, double ele,
                                                 bool eleValid, double t,
                                                 QString text) {
  const QJsonObject a{{"runId", runId}, {"lat", lat},   {"lon", lon},
                      {"ele", ele},     {"eleValid", eleValid}, {"t", t},
                      {"text", text}};
  const QString e = modules().perun_core.addAnnotation(
      QString::fromUtf8(QJsonDocument(a).toJson(QJsonDocument::Compact)));
  refresh();
  return e;
}

// ---- Media: core decrypts (has the key), view caches into its sandbox ----

QString PerunAnalyticsBackend::mediaDir() const {
  const QString base =
      m_tileRoot.isEmpty()
          ? QStandardPaths::writableLocation(QStandardPaths::TempLocation) +
                QStringLiteral("/perun")
          : m_tileRoot;
  return base + QStringLiteral("/media");
}

QString PerunAnalyticsBackend::loadMedia(QString blobId, QString mime) {
  static const QRegularExpression kHex(QStringLiteral("^[0-9a-f]{64}$"));
  if (!kHex.match(blobId).hasMatch())
    return QString();

  const QString path =
      mediaDir() + QStringLiteral("/") + blobId + QStringLiteral(".") + extForMime(mime);
  const QFileInfo cached(path);
  if (cached.exists() && cached.size() > 0)
    return QUrl::fromLocalFile(path).toString(); // synchronous cache hit

  // Pull the DECRYPTED bytes from the core (local-first store or its blob server).
  const QString b64 = modules().perun_core.getMedia(blobId, mime);
  if (b64.isEmpty()) {
    QTimer::singleShot(0, this, [this, blobId]() {
      emit mediaFailed(blobId, QStringLiteral("unavailable"));
    });
    return QString();
  }
  const QByteArray pt = QByteArray::fromBase64(b64.toUtf8());
  const QString dir = mediaDir();
  if (!QDir().mkpath(dir)) {
    QTimer::singleShot(0, this, [this, blobId]() {
      emit mediaFailed(blobId, QStringLiteral("cache dir unwritable"));
    });
    return QString();
  }
  if (m_tileRoot.isEmpty())
    logEvent("media root unset — decrypted media may be sandbox-blocked");
  QSaveFile f(path);
  if (!f.open(QIODevice::WriteOnly) || f.write(pt) < 0 || !f.commit()) {
    QTimer::singleShot(0, this, [this, blobId]() {
      emit mediaFailed(blobId, QStringLiteral("cache write failed"));
    });
    return QString();
  }
  const QString url = QUrl::fromLocalFile(path).toString();
  QTimer::singleShot(0, this, [this, blobId, url]() { emit mediaReady(blobId, url); });
  return url; // also returned synchronously for a same-tick consumer
}

// ---- QR (presentational; vendored encoder) ----

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

// ---- OSM raster basemap tiles (sandbox-coupled) ----

QString PerunAnalyticsBackend::setTileRoot(QString dirUrl) {
  QString path = QUrl(dirUrl).isLocalFile() ? QUrl(dirUrl).toLocalFile() : dirUrl;
  while (path.endsWith('/'))
    path.chop(1);
  m_tileRoot = path;
  logEvent("tile root = " + m_tileRoot.toStdString());
  return QString();
}

QString PerunAnalyticsBackend::ensureTile(int z, int x, int y) {
  if (z < 0 || z > kMaxTileZoom)
    return QString();
  const int n = 1 << z;
  if (x < 0 || x >= n || y < 0 || y >= n)
    return QString();

  if (m_tileRoot.isEmpty())
    logEvent("tile root unset — tiles will be sandbox-blocked");
  const QString dir =
      (m_tileRoot.isEmpty() ? QStandardPaths::writableLocation(QStandardPaths::TempLocation) +
                                  QStringLiteral("/perun")
                            : m_tileRoot) +
      QStringLiteral("/tiles");
  const QString path =
      QStringLiteral("%1/%2_%3_%4.png").arg(dir).arg(z).arg(x).arg(y);

  const QFileInfo cached(path);
  if (cached.exists() && cached.size() > 0)
    return QUrl::fromLocalFile(path).toString();

  if (!QDir().mkpath(dir))
    return QString();
  if (!m_net)
    m_net = new QNetworkAccessManager(this);

  const QString url =
      QStringLiteral("https://tile.openstreetmap.org/%1/%2/%3.png").arg(z).arg(x).arg(y);
  QNetworkRequest req{QUrl(url)};
  req.setHeader(QNetworkRequest::UserAgentHeader, QString::fromLatin1(kTileUserAgent));
  req.setAttribute(QNetworkRequest::RedirectPolicyAttribute,
                   QNetworkRequest::NoLessSafeRedirectPolicy);

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
  reply->abort();
  reply->deleteLater();

  if (!ok || data.isEmpty()) {
    logEvent("tile fetch failed " + std::to_string(z) + "/" + std::to_string(x) +
             "/" + std::to_string(y));
    return QString();
  }
  QSaveFile f(path);
  if (!f.open(QIODevice::WriteOnly))
    return QString();
  f.write(data);
  if (!f.commit())
    return QString();
  return QUrl::fromLocalFile(path).toString();
}
