#include "blob_server.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QHostAddress>
#include <QNetworkInterface>
#include <QRegularExpression>
#include <QTcpServer>
#include <QTcpSocket>

PerunBlobServer::PerunBlobServer(QString storeDir, quint16 port, QString token,
                                 QObject *parent)
    : QObject(parent), m_storeDir(std::move(storeDir)), m_token(std::move(token)),
      m_port(port) {}

bool PerunBlobServer::start() {
  QDir().mkpath(m_storeDir);
  if (m_server)
    return m_server->isListening();
  m_server = new QTcpServer(this);
  connect(m_server, &QTcpServer::newConnection, this, &PerunBlobServer::onNewConnection);
  // Listen on all interfaces so a phone on the LAN can reach it.
  if (!m_server->listen(QHostAddress::Any, m_port)) {
    // Fall back to an OS-assigned port so a clash never disables the feature.
    if (!m_server->listen(QHostAddress::Any, 0))
      return false;
    m_port = m_server->serverPort();
  } else {
    m_port = m_server->serverPort();
  }
  return true;
}

bool PerunBlobServer::listening() const {
  return m_server && m_server->isListening();
}

QString PerunBlobServer::url() const {
  if (!listening())
    return QString();
  // Pick the first non-loopback IPv4 — the address a phone on the LAN would use.
  const auto addrs = QNetworkInterface::allAddresses();
  QString ip;
  for (const QHostAddress &a : addrs) {
    if (a.isLoopback() || a.protocol() != QAbstractSocket::IPv4Protocol)
      continue;
    ip = a.toString();
    break;
  }
  if (ip.isEmpty())
    return QString();
  return QStringLiteral("http://%1:%2").arg(ip).arg(m_port);
}

void PerunBlobServer::onNewConnection() {
  while (m_server && m_server->hasPendingConnections()) {
    QTcpSocket *sock = m_server->nextPendingConnection();
    m_conns.insert(sock, Conn{});
    connect(sock, &QTcpSocket::readyRead, this, &PerunBlobServer::onReadyRead);
    connect(sock, &QTcpSocket::disconnected, this, &PerunBlobServer::onDisconnected);
  }
}

void PerunBlobServer::onDisconnected() {
  auto *sock = qobject_cast<QTcpSocket *>(sender());
  if (!sock)
    return;
  m_conns.remove(sock);
  sock->deleteLater();
}

void PerunBlobServer::onReadyRead() {
  auto *sock = qobject_cast<QTcpSocket *>(sender());
  if (!sock)
    return;
  auto it = m_conns.find(sock);
  if (it == m_conns.end())
    return;
  Conn &c = it.value();
  c.buf += sock->readAll();
  // Guard against unbounded buffering before we've even parsed headers.
  if (!c.headersDone && c.buf.size() > 64 * 1024) {
    respond(sock, 431, "Request Header Fields Too Large", "text/plain", "headers too large");
    return;
  }
  process(sock, c);
}

// Parse request-line + headers once, then wait for Content-Length bytes of body.
void PerunBlobServer::process(QTcpSocket *sock, Conn &c) {
  if (c.bad)
    return;
  if (!c.headersDone) {
    const int end = c.buf.indexOf("\r\n\r\n");
    if (end < 0)
      return; // headers still incomplete
    c.headerEnd = end + 4;
    const QByteArray head = c.buf.left(end);
    const QList<QByteArray> lines = head.split('\n');
    if (lines.isEmpty()) {
      respond(sock, 400, "Bad Request", "text/plain", "bad request");
      return;
    }
    const QList<QByteArray> reqline = lines.first().trimmed().split(' ');
    if (reqline.size() < 2) {
      respond(sock, 400, "Bad Request", "text/plain", "bad request line");
      return;
    }
    c.method = reqline[0].trimmed().toUpper();
    c.path = reqline[1].trimmed();
    for (int i = 1; i < lines.size(); ++i) {
      const QByteArray ln = lines[i].trimmed();
      const int colon = ln.indexOf(':');
      if (colon < 0)
        continue;
      const QByteArray key = ln.left(colon).trimmed().toLower();
      const QByteArray val = ln.mid(colon + 1).trimmed();
      if (key == "content-length")
        c.contentLength = val.toLongLong();
      else if (key == "authorization" && !m_token.isEmpty()) {
        // Stash on the Conn via a fake header check below; store in path? Keep simple:
        // compare here and mark bad if mismatch for a POST (checked in handleRequest).
      }
    }
    if (c.contentLength < 0 || c.contentLength > m_maxBytes) {
      respond(sock, 413, "Payload Too Large", "text/plain", "payload too large");
      return;
    }
    c.headersDone = true;
  }

  // Body: for GET/HEAD there is none; for POST wait for Content-Length bytes.
  const qint64 have = c.buf.size() - c.headerEnd;
  if (c.method == "POST" && have < c.contentLength)
    return; // wait for the rest of the body
  const QByteArray body = c.buf.mid(c.headerEnd, static_cast<int>(c.contentLength));
  // Optional bearer check on writes.
  if (c.method == "POST" && !m_token.isEmpty()) {
    const QByteArray want = "Bearer " + m_token.toUtf8();
    if (!c.buf.left(c.headerEnd).toLower().contains(("authorization: " + want).toLower())) {
      respond(sock, 401, "Unauthorized", "text/plain", "unauthorized");
      return;
    }
  }
  handleRequest(sock, c, body);
}

void PerunBlobServer::handleRequest(QTcpSocket *sock, Conn &c, const QByteArray &body) {
  c.bad = true; // one response per connection; ignore anything trailing

  // Strip a query string if present.
  QByteArray path = c.path;
  const int q = path.indexOf('?');
  if (q >= 0)
    path = path.left(q);

  if (c.method == "GET" && path == "/healthz") {
    respond(sock, 200, "OK", "text/plain", "ok");
    return;
  }

  if (c.method == "POST" && path == "/blob") {
    const QByteArray id =
        QCryptographicHash::hash(body, QCryptographicHash::Sha256).toHex();
    const QString file = m_storeDir + QLatin1Char('/') + QString::fromLatin1(id);
    const bool existed = QFileInfo::exists(file);
    if (!existed) {
      QFile f(file);
      if (!f.open(QIODevice::WriteOnly) || f.write(body) != body.size()) {
        respond(sock, 500, "Internal Server Error", "text/plain", "write failed");
        return;
      }
      f.close();
      emit stored(QString::fromLatin1(id));
    }
    const QByteArray json = "{\"id\":\"" + id + "\",\"size\":" +
                            QByteArray::number(body.size()) + ",\"dedup\":" +
                            (existed ? "true" : "false") + "}";
    respond(sock, 200, "OK", "application/json", json);
    return;
  }

  if ((c.method == "GET" || c.method == "HEAD") && path.startsWith("/blob/")) {
    const QByteArray id = path.mid(6);
    static const QRegularExpression kHex(QStringLiteral("^[0-9a-f]{64}$"));
    if (!kHex.match(QString::fromLatin1(id)).hasMatch()) {
      respond(sock, 400, "Bad Request", "text/plain", "bad id");
      return;
    }
    const QString file = m_storeDir + QLatin1Char('/') + QString::fromLatin1(id);
    QFile f(file);
    if (!f.exists() || !f.open(QIODevice::ReadOnly)) {
      respond(sock, 404, "Not Found", "text/plain", "not found");
      return;
    }
    const QByteArray data = (c.method == "HEAD") ? QByteArray() : f.readAll();
    respond(sock, 200, "OK", "application/octet-stream", data);
    return;
  }

  respond(sock, 404, "Not Found", "text/plain", "not found");
}

void PerunBlobServer::respond(QTcpSocket *sock, int code, const QByteArray &reason,
                              const QByteArray &contentType, const QByteArray &body) {
  QByteArray resp = "HTTP/1.1 " + QByteArray::number(code) + " " + reason + "\r\n";
  resp += "Content-Type: " + contentType + "\r\n";
  resp += "Content-Length: " + QByteArray::number(body.size()) + "\r\n";
  resp += "Access-Control-Allow-Origin: *\r\n";
  resp += "Connection: close\r\n\r\n";
  resp += body;
  sock->write(resp);
  sock->flush();
  sock->disconnectFromHost();
}
