#pragma once
// Standard gzip (.gz) compress/decompress via zlib — interoperable with any
// tool (unlike Qt's qCompress, which prepends a non-standard length header).
#include <stdexcept>

#include <QByteArray>
#include <zlib.h>

namespace perun {

inline QByteArray gzip(const QByteArray &in) {
  z_stream zs{};
  // windowBits 15 + 16 -> gzip wrapper
  if (deflateInit2(&zs, Z_BEST_COMPRESSION, Z_DEFLATED, 15 + 16, 8,
                   Z_DEFAULT_STRATEGY) != Z_OK)
    throw std::runtime_error("gzip: deflateInit2 failed");
  zs.next_in = reinterpret_cast<Bytef *>(const_cast<char *>(in.constData()));
  zs.avail_in = static_cast<uInt>(in.size());
  QByteArray out;
  char buf[32768];
  int ret;
  do {
    zs.next_out = reinterpret_cast<Bytef *>(buf);
    zs.avail_out = sizeof(buf);
    ret = deflate(&zs, Z_FINISH);
    out.append(buf, static_cast<int>(sizeof(buf) - zs.avail_out));
  } while (ret != Z_STREAM_END);
  deflateEnd(&zs);
  return out;
}

inline QByteArray gunzip(const QByteArray &in) {
  z_stream zs{};
  if (inflateInit2(&zs, 15 + 16) != Z_OK)
    throw std::runtime_error("gunzip: inflateInit2 failed");
  zs.next_in = reinterpret_cast<Bytef *>(const_cast<char *>(in.constData()));
  zs.avail_in = static_cast<uInt>(in.size());
  QByteArray out;
  char buf[32768];
  int ret;
  do {
    zs.next_out = reinterpret_cast<Bytef *>(buf);
    zs.avail_out = sizeof(buf);
    ret = inflate(&zs, Z_NO_FLUSH);
    if (ret != Z_OK && ret != Z_STREAM_END) {
      inflateEnd(&zs);
      throw std::runtime_error("gunzip: inflate failed");
    }
    out.append(buf, static_cast<int>(sizeof(buf) - zs.avail_out));
  } while (ret != Z_STREAM_END);
  inflateEnd(&zs);
  return out;
}

} // namespace perun
