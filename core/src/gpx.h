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

// Namespace for our own extensions. Must match the phone's PERUN_NS.
inline constexpr const char *kPerunNs = "https://github.com/vpavlin/perun/1";

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
       "xmlns:gpxtpx=\"http://www.garmin.com/xmlschemas/TrackPointExtension/v1\" "
       "xmlns:perun=\"" + QLatin1String(kPerunNs) + "\">\n";
  s += "<trk>";
  if (!tr.name.empty())
    s += "<name>" + detail::xmlEscape(QString::fromStdString(tr.name)) + "</name>";
  // <type> is the standard GPX ACTIVITY type — Strava/Garmin classify from it,
  // so it carries the sport. The training category is ours, so it rides in a
  // perun: extension (3rd parties ignore unknown extensions).
  // Schema order: name → … → type → extensions → trkseg.
  if (!tr.sport.empty())
    s += "<type>" + detail::xmlEscape(QString::fromStdString(tr.sport)) + "</type>";
  if (!tr.category.empty())
    s += "<extensions><perun:category>" +
         detail::xmlEscape(QString::fromStdString(tr.category)) +
         "</perun:category></extensions>";
  s += "<trkseg>\n";
  for (size_t i = 0; i < tr.points.size(); ++i) {
    const auto &p = tr.points[i];
    // A break opens a new <trkseg> — that IS how GPX represents a pause, and
    // readers already know not to draw across segments.
    if (p.brk && i > 0)
      s += "</trkseg><trkseg>\n";
    s += "<trkpt lat=\"" + QString::number(p.lat, 'f', 7) + "\" lon=\"" +
         QString::number(p.lon, 'f', 7) + "\">";
    // Only emit <ele> for points that actually carried altitude — writing
    // ele=0 for a no-fix point would recreate the phantom-swing on re-parse.
    if (tr.hasAlt && p.altValid)
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
  std::string rawType;
  // Scope the header fields to <trk> so a <name> in <metadata> (Strava exports
  // have one) can't win over the track's own name.
  bool inPt = false, inTrk = false, pendingBrk = false;
  int segIdx = 0;
  while (!r.atEnd()) {
    const auto tok = r.readNext();
    if (tok == QXmlStreamReader::StartElement) {
      const auto n = r.name();
      if (n == QLatin1String("trk")) {
        inTrk = true;
      } else if (n == QLatin1String("trkseg")) {
        // Every segment after the first opens with a gap (our pause, or a
        // watch's signal dropout). Flag its first point so analytics won't
        // bridge it.
        segIdx++;
        pendingBrk = segIdx > 1;
      } else if (n == QLatin1String("trkpt")) {
        cur = GeoPoint{};
        cur.lat = r.attributes().value("lat").toDouble();
        cur.lon = r.attributes().value("lon").toDouble();
        cur.brk = pendingBrk;
        pendingBrk = false;
        inPt = true;
      } else if (inTrk && !inPt && n == QLatin1String("name")) {
        tr.name = r.readElementText().toStdString();
      } else if (inTrk && !inPt && n == QLatin1String("type")) {
        rawType = r.readElementText().toStdString();
      } else if (inTrk && !inPt && n == QLatin1String("category")) {
        tr.category = r.readElementText().toStdString();
      } else if (inPt && n == QLatin1String("ele")) {
        cur.alt = r.readElementText().toDouble();
        cur.altValid = true; // this trkpt carried a real altitude
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
      } else if (r.name() == QLatin1String("trk")) {
        inTrk = false;
      }
    }
  }
  // <type> normally holds the sport. But runs written BEFORE the sport/category
  // split put the CATEGORY there (e.g. "Long"), so an unrecognised value is
  // treated as a category — old tracks degrade correctly instead of claiming to
  // be a sport called "Long". Mirrors fromGpx() in mobile/src/lib/gpx.ts.
  if (isKnownSport(rawType))
    tr.sport = rawType;
  else if (tr.category.empty())
    tr.category = rawType;
  return tr;
}

} // namespace perun
