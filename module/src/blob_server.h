// Embedded content-addressed blob server for the Perun Analytics module.
//
// The desktop Basecamp instance doubles as the household's media hub: photos and voice
// notes captured on a phone are SEALED there, then uploaded here so other devices can
// fetch them. It autostarts with the module (no separate process) and speaks the exact
// contract the mobile BlobBackend already uses:
//   POST /blob        body = sealed bytes            -> 200 {"id":"<sha256hex>","size":N,"dedup":bool}
//   GET  /blob/<id>   id = 64-hex sha256 of the body -> 200 application/octet-stream (the sealed bytes)
//   GET  /healthz                                    -> 200 ok
// ZERO-TRUST: it only ever stores/serves ciphertext, addressed by sha256(body) (== the
// mobile "cid"). It is deliberately a tiny HTTP/1.1 server over QTcpServer (Qt::Network,
// already linked) rather than a Qt::HttpServer dependency. This is the swap point for a
// future Logos Storage backend — the mobile side never changes.
#pragma once

#include <QHash>
#include <QObject>
#include <QString>

class QTcpServer;
class QTcpSocket;

class PerunBlobServer : public QObject {
  Q_OBJECT
public:
  // storeDir: where sealed blobs live (created if needed). token: optional bearer
  // required on POST (empty = open, fine for a household LAN). maxBytes: body cap.
  PerunBlobServer(QString storeDir, quint16 port, QString token, QObject *parent = nullptr);

  // Begin listening on all interfaces. Returns false (and logs) if the port is taken.
  bool start();
  bool listening() const;
  quint16 port() const { return m_port; }
  // "http://<first-LAN-IPv4>:<port>" for display, or empty if no LAN address found.
  QString url() const;

signals:
  // A new (not-previously-held) sealed blob was stored — its id is sha256hex(body).
  void stored(const QString &id);

private slots:
  void onNewConnection();
  void onReadyRead();
  void onDisconnected();

private:
  struct Conn {
    QByteArray buf;      // accumulated request bytes
    bool headersDone = false;
    bool bad = false;    // set once we've decided to reject
    QByteArray method;
    QByteArray path;
    qint64 contentLength = 0;
    int headerEnd = -1;  // index just past the \r\n\r\n
  };

  void process(QTcpSocket *sock, Conn &c);
  void handleRequest(QTcpSocket *sock, Conn &c, const QByteArray &body);
  void respond(QTcpSocket *sock, int code, const QByteArray &reason,
               const QByteArray &contentType, const QByteArray &body);

  QTcpServer *m_server = nullptr;
  QHash<QTcpSocket *, Conn> m_conns;
  QString m_storeDir;
  QString m_token;
  quint16 m_port;
  qint64 m_maxBytes = 64LL * 1024 * 1024; // 64 MB per blob
};
