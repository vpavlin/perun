#pragma once
// GPX 1.1 (with the Garmin TrackPointExtension for HR) <-> perun::Track.
// This is the interchange format: what the phone/watch/Strava produce, and what
// travels (gzipped) over Delivery. Serialize by hand for predictable output;
// parse with QXmlStreamReader for robustness.
#include <QByteArray>
#include <QDateTime>
#include <QString>
#include <QXmlStreamReader>

#include "geo.h"

namespace perun {

namespace detail {
inline QString xmlEscape(const QString &s) {
  QString o = s;
  o.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
      .replace('"', "&quot;").replace('\'', "&apos;");
  return o;
}
} // namespace detail

inline QByteArray toGpx(const Track &tr) {
  QString s;
  s.reserve(static_cast<int>(tr.points.size()) * 160 + 256);
  s += "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n";
  s += "<gpx version=\"1.1\" creator=\"Perun\" "
       "xmlns=\"http://www.topografix.com/GPX/1/1\" "
       "xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\">\n";
  s += "<trk>";
  if (!tr.name.empty())
    s += "<name>" + detail::xmlEscape(QString::fromStdString(tr.name)) + "</name>";
  // <type> is the standard GPX activity/category field (schema order: name → …
  // → type → trkseg). Garmin/Strava read it, so the category survives export.
  if (!tr.type.empty())
    s += "<type>" + detail::xmlEscape(QString::fromStdString(tr.type)) + "</type>";
  s += "<trkseg>\n";
  for (const auto &p : tr.points) {
    s += "<trkpt lat=\"" + QString::number(p.lat, 'f', 7) + "\" lon=\"" +
         QString::number(p.lon, 'f', 7) + "\">";
    if (tr.hasAlt)
      s += "<ele>" + QString::number(p.alt, 'f', 1) + "</ele>";
    s += "<time>" +
         QDateTime::fromMSecsSinceEpoch(p.t, Qt::UTC).toString(Qt::ISODateWithMs) +
         "</time>";
    if (tr.hasHr)
      s += "<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>" +
           QString::number(p.hr) +
           "</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>";
    s += "</trkpt>\n";
  }
  s += "</trkseg></trk></gpx>\n";
  return s.toUtf8();
}

inline Track fromGpx(const QByteArray &xml) {
  Track tr;
  QXmlStreamReader r(xml);
  GeoPoint cur{};
  bool inPt = false;
  while (!r.atEnd()) {
    const auto tok = r.readNext();
    if (tok == QXmlStreamReader::StartElement) {
      const auto n = r.name();
      if (n == QLatin1String("trkpt")) {
        cur = GeoPoint{};
        cur.lat = r.attributes().value("lat").toDouble();
        cur.lon = r.attributes().value("lon").toDouble();
        inPt = true;
      } else if (n == QLatin1String("name") && !inPt) {
        tr.name = r.readElementText().toStdString();
      } else if (n == QLatin1String("type") && !inPt) {
        tr.type = r.readElementText().toStdString();
      } else if (inPt && n == QLatin1String("ele")) {
        cur.alt = r.readElementText().toDouble();
        tr.hasAlt = true;
      } else if (inPt && n == QLatin1String("time")) {
        cur.t = QDateTime::fromString(r.readElementText(), Qt::ISODateWithMs)
                    .toMSecsSinceEpoch();
      } else if (inPt && n == QLatin1String("hr")) {
        cur.hr = r.readElementText().toInt();
        tr.hasHr = true;
      }
    } else if (tok == QXmlStreamReader::EndElement) {
      if (r.name() == QLatin1String("trkpt")) {
        tr.points.push_back(cur);
        inPt = false;
      }
    }
  }
  return tr;
}

} // namespace perun
