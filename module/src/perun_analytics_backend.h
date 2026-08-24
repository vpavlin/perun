#pragma once

#include <QByteArray>
#include <QString>

#include "rep_perun_analytics_source.h"
#include "logos_ui_plugin_context.h"

class QNetworkAccessManager;
class QTimer;

/**
 * @brief Thin UI backend for the Perun Analytics view (ADR 0006).
 *
 * All engine/sync/identity/store logic lives in the headless `perun_core` module
 * (which also runs as the always-on hub). This backend is a PROXY: it polls
 * `modules().perun_core.snapshot()` on a timer and mirrors the folded state into
 * the .rep PROPs (so Main.qml is unchanged), forwards commands to `perun_core`,
 * and keeps only the presentation that is coupled to the QML sandbox:
 *   - OSM raster basemap tiles (setTileRoot / ensureTile),
 *   - QR encoding of the pairing URI (qrMatrix, vendored Nayuki encoder),
 *   - media-file caching: getMedia() from the core returns decrypted bytes, which
 *     we write into the view sandbox so QQuickImage/MediaPlayer can read them.
 */
class PerunAnalyticsBackend : public PerunAnalyticsSimpleSource,
                              public LogosUiPluginContext {
public:
  // .rep SLOTs — most forward to perun_core; tiles/qr/media stay local.
  QString publishSampleRun() override;
  QString trackJson(QString runId) override;
  QString exportGpx(QString runId) override;
  QString setTileRoot(QString dirUrl) override;
  QString ensureTile(int z, int x, int y) override;
  QString resetPairing() override;
  QString qrMatrix(QString text) override;
  QString configureBlobServer(QString url, QString token) override;
  QString loadMedia(QString blobId, QString mime) override;
  QString addTextAnnotation(QString runId, double lat, double lon, double ele,
                            bool eleValid, double t, QString text) override;

protected:
  void onContextReady() override;

private:
  // Poll perun_core.snapshot() and mirror the folded state into the PROPs.
  void refresh();
  // Media cache dir: inside the view sandbox (the tile root) so the decrypted
  // file:// is readable; falls back to a temp dir.
  QString mediaDir() const;

  QNetworkAccessManager *m_net = nullptr; // OSM tile fetch (ensureTile)
  QString m_tileRoot;                     // sandbox-readable dir from the view
  QTimer *m_poll = nullptr;               // snapshot() poll
};
