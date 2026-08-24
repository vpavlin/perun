import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import QtQuick.Shapes

import Logos.Theme
import Logos.Controls

Item {
    id: root

    readonly property var backend: logos.module("perun_analytics")
    property bool ready: false
    readonly property string status: backend ? backend.status : ""
    readonly property var runs: backend ? JSON.parse(backend.runsJson || "[]") : []
    property int selectedIndex: 0
    readonly property var selectedRun: (runs.length > 0 && selectedIndex >= 0 && selectedIndex < runs.length) ? runs[selectedIndex] : null
    // Trends dashboard vs single-run detail. The right pane shows aggregate
    // trends across all runs when this is on.
    property bool showTrends: false

    // Decoded points for the selected run's route map (fetched on demand).
    property var trackPoints: []

    // ---- Journey annotations (photos / voice / text pinned to a point) ----
    // Backend publishes { runId: [ann, …] } as a PROP; pick the selected run's.
    readonly property var allAnnotations: backend ? JSON.parse(backend.annotationsJson || "{}") : ({})
    readonly property var annotations: (selectedRun && allAnnotations[selectedRun.id]) ? allAnnotations[selectedRun.id] : []
    // Index into `annotations` linking a tapped map marker to the list (and back).
    property int selectedAnnotation: -1
    // blobId -> decrypted file:// url, or "error" / "loading". New object ref on
    // each change so bindings re-evaluate (QML can't see in-place mutation).
    property var mediaUrls: ({})

    // ---- Replay mode: drag a playhead along the route; the annotation you're
    //      passing surfaces in a side panel with the stats at that point. ----
    property bool replayMode: false
    property int headIdx: 0                 // playhead = trackPoints[headIdx]
    property var cumDist: []                // cumulative distance (m) per track point
    property real totalDist: 0
    property int featIdx: -1               // featured annotation (nearest to playhead)
    property real featGap: 1e18            // metres between playhead and featured ann
    readonly property real featThreshold: Math.max(40, totalDist * 0.02)

    function rebuildCum() {
        var pts = root.trackPoints || [];
        var c = new Array(pts.length);
        var d = 0;
        for (var i = 0; i < pts.length; i++) {
            if (i > 0 && !pts[i].brk)
                d += root.haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
            c[i] = d;
        }
        root.cumDist = c;
        root.totalDist = pts.length ? c[pts.length - 1] : 0;
        if (root.headIdx >= pts.length) root.headIdx = Math.max(0, pts.length - 1);
        root.recomputeFeatured();
    }
    function headDist() {
        return (root.cumDist.length && root.headIdx < root.cumDist.length) ? root.cumDist[root.headIdx] : 0;
    }
    function nearestIdxToDist(dist) {
        var c = root.cumDist;
        if (!c.length) return 0;
        var best = 0, bd = 1e18;
        for (var i = 0; i < c.length; i++) { var g = Math.abs(c[i] - dist); if (g < bd) { bd = g; best = i; } }
        return best;
    }
    function annDistance(ann) {
        var p = root.trackPoints, c = root.cumDist;
        if (!p.length) return 0;
        var best = 0, bd = 1e18;
        for (var i = 0; i < p.length; i++) { var g = root.haversine(p[i].lat, p[i].lon, ann.lat, ann.lon); if (g < bd) { bd = g; best = i; } }
        return c[best] || 0;
    }
    function recomputeFeatured() {
        var as = root.annotations;
        if (!as || !as.length) { root.featIdx = -1; root.featGap = 1e18; return; }
        var hd = root.headDist();
        var bi = -1, bd = 1e18;
        for (var i = 0; i < as.length; i++) { var g = Math.abs(root.annDistance(as[i]) - hd); if (g < bd) { bd = g; bi = i; } }
        root.featIdx = bi; root.featGap = bd;
    }
    onHeadIdxChanged: root.recomputeFeatured()
    onAnnotationsChanged: root.recomputeFeatured()
    onTrackPointsChanged: root.rebuildCum()

    function setMedia(blobId, val) {
        var m = {};
        for (var k in root.mediaUrls) m[k] = root.mediaUrls[k];
        m[blobId] = val;
        root.mediaUrls = m;
    }
    // Kick a fetch+decrypt for a blob (idempotent). A cache hit resolves the
    // watch synchronously; otherwise the backend emits mediaReady/mediaFailed.
    function ensureMedia(blobId, mime) {
        if (!backend || !blobId) return;
        var cur = root.mediaUrls[blobId];
        if (cur && cur !== "error") return; // have it (or in flight as a url)
        root.setMedia(blobId, "loading");
        logos.watch(backend.loadMedia(blobId, mime || ""),
            function (url) { if (url && url.length > 0) root.setMedia(blobId, url); },
            function (e) { /* async — result arrives via the signals below */ });
    }
    function iconForKind(k) {
        return k === "photo" ? "📷" : (k === "voice" ? "🎙️" : "💬");
    }
    // Load (if needed) then play a voice blob. If the media is still fetching we
    // just kick the fetch; the user taps ▶ again once it is ready.
    function playVoice(blobId, mime) {
        var u = root.mediaUrls[blobId];
        if (!u || u === "error") { root.ensureMedia(blobId, mime); return; }
        if (u === "loading") return;
        if (voicePlayerLoader.status === Loader.Ready && voicePlayerLoader.item) {
            voicePlayerLoader.item.play(u);
        } else {
            voicePlayerLoader.pendingUrl = u;
            voicePlayerLoader.active = true;
        }
    }

    // Isolated audio player — QtMultimedia is imported only inside VoicePlayer.qml
    // so a runtime without it degrades this one control instead of failing the
    // whole view to load. Instantiated lazily on first playback.
    Loader {
        id: voicePlayerLoader
        active: false
        source: "VoicePlayer.qml"
        property string pendingUrl: ""
        onStatusChanged: {
            if (status === Loader.Ready && item && pendingUrl.length > 0) {
                item.play(pendingUrl); pendingUrl = "";
            } else if (status === Loader.Error) {
                console.log("[perun] VoicePlayer unavailable (no QtMultimedia?)");
            }
        }
    }

    // True once setTileRoot has ACTUALLY landed on the backend. QtRO SLOT calls
    // from QML are async (they return a pending handle, not the value), so
    // setTileRoot and ensureTile race: without this gate a tile can be fetched
    // before the root is set, landing in the backend's data dir — which is NOT
    // under the plugin sandbox's allowed roots, so the Image read is blocked and
    // the map silently stays empty. Confirmed pattern:
    // logos-co/logos-witness-test/docs/photo-display-investigation.md.
    property bool tileRootReady: false

    Connections {
        target: logos
        function onViewModuleReadyChanged(moduleName, isReady) {
            if (moduleName === "perun_analytics")
                root.ready = isReady && root.backend !== null;
        }
    }
    Component.onCompleted: {
        root.ready = root.backend !== null && logos.isViewModuleReady("perun_analytics");
        // NB: do NOT call setTileRoot here. Component.onCompleted runs before the
        // QtRO backend replica is connected — a SLOT call now hits
        // "connectionToSource is null" and is silently dropped, which is exactly
        // why the tile root never got set. applyTileRoot() runs later, once the
        // connection is proven live (see below).
        applyTileRoot();
        fetchTrack();
    }

    // Point the backend's tile cache at this view's own dir (inside the plugin
    // sandbox, so Image can read file:// tiles from it). Idempotent and safe to
    // call repeatedly: it no-ops once set, and each call is a fresh attempt for
    // the case where earlier ones fired before the replica was connected.
    function applyTileRoot() {
        if (root.tileRootReady || !backend) return;
        console.log("[perun] tile root ->", Qt.resolvedUrl("."));
        logos.watch(backend.setTileRoot(Qt.resolvedUrl(".")),
            function () {
                root.tileRootReady = true;
                if (mapBox.layout) mapBox.fetchTiles();  // kick the current map
            },
            function (e) { console.log("[perun] setTileRoot pending (will retry):", e); });
    }

    // Selecting a run is the first point the backend connection is provably live
    // (trackJson resolves here). Retry the tile root then — the initial
    // Component.onCompleted attempt raced ahead of the connection.
    onSelectedRunChanged: { root.selectedAnnotation = -1; root.headIdx = 0; applyTileRoot(); fetchTrack(); }

    // Also retry when backend PROPs sync — a PROP update proves the replica is
    // connected, covering the case where runs load before any manual selection.
    Connections {
        target: root.backend
        ignoreUnknownSignals: true
        function onRunsJsonChanged() { root.applyTileRoot(); }
        function onStatusChanged() { root.applyTileRoot(); }
        // Async media results from loadMedia (photo/voice fetch + decrypt).
        function onMediaReady(blobId, fileUrl) { root.setMedia(blobId, fileUrl); }
        function onMediaFailed(blobId, error) {
            console.log("[perun] media failed", blobId, error);
            root.setMedia(blobId, "error");
        }
    }

    function fetchTrack() {
        if (!backend || !selectedRun) { root.trackPoints = []; return; }
        logos.watch(backend.trackJson(selectedRun.id),
                    function (json) { root.trackPoints = JSON.parse(json || "[]"); },
                    function (e) { root.trackPoints = []; });
    }

    // ---- formatting helpers ----
    function fmtDist(m) { return ((m || 0) / 1000).toFixed(2) + " km"; }
    function fmtPace(s) {
        if (!s || s <= 0) return "—";
        var m = Math.floor(s / 60), sec = Math.round(s % 60);
        return m + ":" + (sec < 10 ? "0" + sec : sec) + " /km";
    }
    function fmtDur(s) {
        s = Math.round(s || 0);
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        var mm = (m < 10 ? "0" + m : m), ss = (sec < 10 ? "0" + sec : sec);
        return h > 0 ? (h + ":" + mm + ":" + ss) : (m + ":" + ss);
    }
    function fmtElev(m) { return Math.round(m || 0) + " m"; }

    // Haversine metres — same as mobile analytics; drives the elevation chart's
    // cumulative-distance x-axis.
    function haversine(lat1, lon1, lat2, lon2) {
        var R = 6371000, D2R = Math.PI / 180;
        var dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
                Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    }

    // ---- trends / aggregates (all computed from root.runs) ----
    // Local Monday 00:00 of the week containing ts (DST-safe via the Date API).
    function weekStartMs(ts) {
        var d = new Date(ts || 0);
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // getDay Sun=0 → Mon=0
        return d.getTime();
    }
    function trendTotals() {
        var t = { runs: 0, dist: 0, dur: 0, elev: 0 };
        var rs = root.runs;
        for (var i = 0; i < rs.length; i++) {
            var s = rs[i].summary; if (!s) continue;
            t.runs++; t.dist += s.distanceM || 0; t.dur += s.durationS || 0; t.elev += s.elevGainM || 0;
        }
        return t;
    }
    // Oldest→newest array of { label, dist } for the last nWeeks weeks.
    function weeklyBars(nWeeks) {
        var keys = [], cur = weekStartMs((new Date()).getTime());
        for (var i = 0; i < nWeeks; i++) {
            keys.push(cur);
            var pd = new Date(cur); pd.setDate(pd.getDate() - 7); cur = weekStartMs(pd.getTime());
        }
        var buckets = {};
        for (var i = 0; i < keys.length; i++) buckets[keys[i]] = 0;
        var rs = root.runs;
        for (var i = 0; i < rs.length; i++) {
            var s = rs[i].summary; if (!s) continue;
            var w = weekStartMs(rs[i].startTs);
            if (w in buckets) buckets[w] += (s.distanceM || 0);
        }
        keys.reverse();
        var out = [];
        for (var i = 0; i < keys.length; i++) {
            var d = new Date(keys[i]);
            out.push({ label: (d.getMonth() + 1) + "/" + d.getDate(), dist: buckets[keys[i]] || 0 });
        }
        return out;
    }
    function personalBests() {
        var rs = root.runs, longest = null, climb = null, fastest = null;
        for (var i = 0; i < rs.length; i++) {
            var s = rs[i].summary; if (!s) continue;
            if (!longest || s.distanceM > longest.summary.distanceM) longest = rs[i];
            if (!climb || s.elevGainM > climb.summary.elevGainM) climb = rs[i];
            if (root.sportInfo(rs[i].sport).foot && s.avgPaceSecPerKm > 0 &&
                (!fastest || s.avgPaceSecPerKm < fastest.summary.avgPaceSecPerKm)) fastest = rs[i];
        }
        return { longest: longest, climb: climb, fastest: fastest };
    }

    // Sport table — mirrors SPORTS in mobile/src/lib/types.ts and isKnownSport()
    // in src/geo.h. `foot` decides pace-vs-speed: min/km is a runner's unit and
    // reads as nonsense on a bike.
    readonly property var sports: [
        { id: "running",       label: "Run",   foot: true  },
        { id: "trail_running", label: "Trail", foot: true  },
        { id: "walking",       label: "Walk",  foot: true  },
        { id: "hiking",        label: "Hike",  foot: true  },
        { id: "cycling",       label: "Ride",  foot: false },
        { id: "mtb",           label: "MTB",   foot: false }
    ]
    function sportInfo(id) {
        for (var i = 0; i < sports.length; i++)
            if (sports[i].id === id) return sports[i];
        return sports[0];
    }
    function fmtSpeed(s) { return (!s || s <= 0) ? "—" : (3600 / s).toFixed(1) + " km/h"; }
    function fmtRate(s, foot) { return foot ? fmtPace(s) : fmtSpeed(s); }
    /** "Run · Tempo", or just the sport, or just the category — no stray dots. */
    function sportLine(run) {
        var parts = [];
        if (run.sport) parts.push(sportInfo(run.sport).label);
        if (run.category) parts.push(run.category);
        return parts.join("  ·  ");
    }

    Rectangle { anchors.fill: parent; color: Theme.palette.background }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.spacing.large
        spacing: Theme.spacing.medium

        LogosText {
            text: "Perun — Analytics"
            color: Theme.palette.text
            font.pixelSize: 22
            font.weight: Theme.typography.weightMedium
        }
        LogosText {
            text: root.ready ? root.status : "Connecting to backend…"
            color: root.ready ? Theme.palette.success : Theme.palette.warning
            font.pixelSize: 13
        }
        LogosText {
            text: backend && backend.fingerprint ? ("Pairing: " + backend.fingerprint) : ""
            color: Theme.palette.textTertiary
            font.pixelSize: 11
        }

        // ---- Master/detail, split HORIZONTALLY ----
        // Was stacked vertically: the list got a hardcoded 150px (≈2 rows) while
        // the summary tiles, map and splits fought over what was left. On a wide
        // desktop window that wasted the horizontal space entirely.
        // SplitView, not a fixed RowLayout, so the divider is draggable.
        SplitView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            orientation: Qt.Horizontal

        // ---- Run list (master) ----
        Rectangle {
            // SplitView.* attached props here — NOT Layout.*: this Rectangle's
            // parent is the SplitView, so Layout.fillWidth would be ignored.
            SplitView.preferredWidth: 320
            SplitView.minimumWidth: 240
            SplitView.fillWidth: false
            color: Theme.palette.backgroundInset
            radius: Theme.spacing.radiusMedium
            border.color: Theme.palette.borderHairline
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.small
                spacing: Theme.spacing.small

                // Trends toggle — flips the right pane to the aggregate dashboard.
                Rectangle {
                    Layout.fillWidth: true
                    height: 38
                    radius: Theme.spacing.radiusSmall
                    color: root.showTrends ? Theme.palette.overlayOrange : Theme.palette.backgroundSecondary
                    border.width: root.showTrends ? 1 : 0
                    border.color: Theme.palette.primary
                    MouseArea { anchors.fill: parent; onClicked: root.showTrends = !root.showTrends }
                    LogosText {
                        anchors.centerIn: parent
                        text: root.showTrends ? "‹ Back to runs" : "📊  Trends & totals"
                        color: root.showTrends ? Theme.palette.primary : Theme.palette.textSecondary
                        font.pixelSize: 14
                        font.weight: Theme.typography.weightMedium
                    }
                }

                ListView {
                id: runList
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                spacing: Theme.spacing.small
                model: root.runs

                delegate: Rectangle {
                    width: runList.width
                    height: 54
                    radius: Theme.spacing.radiusSmall
                    color: index === root.selectedIndex ? Theme.palette.overlayOrange : Theme.palette.backgroundSecondary
                    border.width: index === root.selectedIndex ? 1 : 0
                    border.color: Theme.palette.primary
                    MouseArea { anchors.fill: parent; onClicked: { root.selectedIndex = index; root.showTrends = false } }
                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: Theme.spacing.medium
                        spacing: Theme.spacing.medium
                        // fillWidth + elide on BOTH lines: in a 320px side panel
                        // a long auto-generated name ("Ride · Tue 14 Nov 09:12")
                        // would otherwise push the pace off the row.
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 2
                            LogosText {
                                text: modelData.name || modelData.id
                                color: Theme.palette.text; font.pixelSize: 15
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
                            LogosText {
                                text: root.fmtDist(modelData.summary ? modelData.summary.distanceM : 0)
                                      + "  ·  " + root.fmtDur(modelData.summary ? modelData.summary.durationS : 0)
                                      + (root.sportLine(modelData) ? "  ·  " + root.sportLine(modelData) : "")
                                color: Theme.palette.textSecondary; font.pixelSize: 12
                                elide: Text.ElideRight
                                Layout.fillWidth: true
                            }
                        }
                        LogosText {
                            text: root.fmtRate(modelData.summary ? modelData.summary.avgPaceSecPerKm : 0,
                                               root.sportInfo(modelData.sport).foot)
                            color: Theme.palette.textSecondary; font.pixelSize: 13
                            Layout.alignment: Qt.AlignVCenter
                        }
                    }
                }
                LogosText {
                    anchors.centerIn: parent
                    visible: root.runs.length === 0
                    text: "No runs yet"
                    color: Theme.palette.textTertiary; font.pixelSize: 14
                }
                }
            }
        }

        // ---- Detail: summary tiles + route map + splits ----
        Rectangle {
            SplitView.fillWidth: true
            SplitView.minimumWidth: 360
            color: Theme.palette.backgroundInset
            radius: Theme.spacing.radiusMedium
            border.color: Theme.palette.borderHairline
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.small
                visible: root.selectedRun !== null && !root.showTrends

                // Summary tiles
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.medium
                    Repeater {
                        model: root.selectedRun ? [
                            { k: "Distance", v: root.fmtDist(root.selectedRun.summary.distanceM) },
                            { k: "Time",     v: root.fmtDur(root.selectedRun.summary.durationS) },
                            { k: "Avg " + (root.sportInfo(root.selectedRun.sport).foot ? "pace" : "speed"),
                              v: root.fmtRate(root.selectedRun.summary.avgPaceSecPerKm,
                                              root.sportInfo(root.selectedRun.sport).foot) },
                            { k: "Elev gain",v: root.fmtElev(root.selectedRun.summary.elevGainM) },
                            { k: "Avg HR",   v: (root.selectedRun.summary.hasHr ? Math.round(root.selectedRun.summary.avgHr) + " bpm" : "—") }
                        ] : []
                        delegate: ColumnLayout {
                            spacing: 2
                            LogosText { text: modelData.k; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                            LogosText { text: modelData.v; color: Theme.palette.text; font.pixelSize: 16; font.weight: Theme.typography.weightMedium }
                        }
                    }
                    Item { Layout.fillWidth: true }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline }

                // Route map — OSM Web-Mercator raster basemap (tiles fetched &
                // cached by the C++ backend) with the GPS track drawn on top in
                // the SAME projection, so the line registers with the map. If no
                // tiles load (offline / fetch error) we fall back to exactly the
                // old behaviour: the track on the plain elevated background.
                Rectangle {
                    id: mapBox
                    Layout.fillWidth: true
                    Layout.preferredHeight: root.replayMode ? 380 : 210
                    radius: Theme.spacing.radiusSmall
                    color: Theme.palette.backgroundElevated
                    border.color: Theme.palette.borderHairline
                    border.width: 1
                    clip: true

                    readonly property int tileSize: 256
                    readonly property int maxZoom: 16  // OSM policy: keep zoom sane

                    // Mercator layout {z,scale,originX,originY,tiles[],key} or null.
                    property var layout: null
                    property var routePts: []
                    // routePts split at pauses — one polyline per <trkseg>, so
                    // the map shows a gap instead of a line across the pause.
                    property var routeSegs: []
                    property point startPt: Qt.point(0, 0)
                    property point endPt: Qt.point(0, 0)
                    // tile id "z/x/y" -> file:// url; hasTiles once any is shown.
                    property var tileUris: ({})
                    property bool hasTiles: false

                    // ---- Web-Mercator (EPSG:3857), identical math to the mobile
                    // ---- side's tiles.ts so both apps render the same frame. ----
                    function mercX(lon) { return (lon + 180) / 360; }
                    function mercY(lat) {
                        var c = Math.min(85.05112878, Math.max(-85.05112878, lat));
                        var r = c * Math.PI / 180;
                        return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
                    }
                    // lat/lon -> pixel in this map's current Mercator frame (same
                    // transform as the track), for placing annotation markers.
                    function project(lat, lon) {
                        if (!layout) return Qt.point(-9999, -9999);
                        return Qt.point(layout.originX + mercX(lon) * layout.scale,
                                        layout.originY + mercY(lat) * layout.scale);
                    }

                    function rebuild() {
                        var pts = root.trackPoints;
                        hasTiles = false;
                        tileUris = {};
                        if (!pts || pts.length < 2 || width <= 0 || height <= 0) {
                            layout = null; routePts = []; routeSegs = []; return;
                        }
                        // Track bbox in normalised Mercator units.
                        var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
                        for (var i = 0; i < pts.length; i++) {
                            var mx = mercX(pts[i].lon), my = mercY(pts[i].lat);
                            if (mx < x0) x0 = mx; if (mx > x1) x1 = mx;
                            if (my < y0) y0 = my; if (my > y1) y1 = my;
                        }
                        var m = 12; // padding so the track never touches the edge
                        var availW = Math.max(1, width - 2 * m);
                        var availH = Math.max(1, height - 2 * m);
                        var spanX = Math.max(1e-12, x1 - x0);
                        var spanY = Math.max(1e-12, y1 - y0);
                        var fit = Math.min(availW / (spanX * tileSize), availH / (spanY * tileSize));
                        var z = Math.max(0, Math.min(maxZoom, Math.floor(Math.log(fit) / Math.LN2)));
                        var scale = tileSize * Math.pow(2, z); // px per Mercator unit
                        var originX = (width - spanX * scale) / 2 - x0 * scale;
                        var originY = (height - spanY * scale) / 2 - y0 * scale;

                        var n = 1 << z;
                        var tx0 = Math.floor(-originX / tileSize), tx1 = Math.floor((width - originX) / tileSize);
                        var ty0 = Math.floor(-originY / tileSize), ty1 = Math.floor((height - originY) / tileSize);
                        var tiles = [];
                        for (var tx = tx0; tx <= tx1; tx++) {
                            for (var ty = ty0; ty <= ty1; ty++) {
                                if (ty < 0 || ty >= n) continue; // past the poles
                                var wx = ((tx % n) + n) % n;      // wrap antimeridian
                                tiles.push({ id: z + "/" + wx + "/" + ty, z: z, x: wx, y: ty,
                                             sx: originX + tx * tileSize, sy: originY + ty * tileSize });
                            }
                        }
                        layout = { z: z, scale: scale, originX: originX, originY: originY,
                                   tiles: tiles, key: z + ":" + tx0 + ":" + tx1 + ":" + ty0 + ":" + ty1 };

                        // Track through the identical transform that places tiles.
                        var out = [];
                        var segs = [];
                        var cur = [];
                        for (i = 0; i < pts.length; i++) {
                            var pt = Qt.point(originX + mercX(pts[i].lon) * scale,
                                              originY + mercY(pts[i].lat) * scale);
                            if (pts[i].brk && cur.length > 0) { segs.push(cur); cur = []; }
                            cur.push(pt);
                            out.push(pt);
                        }
                        if (cur.length > 0) segs.push(cur);
                        routePts = out;
                        routeSegs = segs;
                        startPt = out[0];
                        endPt = out[out.length - 1];

                        // Tiles are fetched by the C++ backend (this QML engine
                        // has no network) and cached under the view's own dir,
                        // then loaded as file:// — which Image reads off disk
                        // WITHOUT the network. A data: URI does NOT work here:
                        // QQuickImage routes it through the NAM, which is
                        // disabled ("Network access disabled for this QML
                        // engine").
                        fetchTiles();
                    }

                    // Drive tile fetches one at a time: the backend blocks its
                    // (separate-process) thread per fetch, so a single in-flight
                    // request means no nested event loops there. Cached after the
                    // first load, so re-opening a run is instant.
                    function fetchTiles() {
                        // Wait for the tile root to be set on the backend, else
                        // tiles cache outside the sandbox and are blocked. The
                        // setTileRoot callback re-invokes this once ready.
                        if (layout && root.backend && root.tileRootReady)
                            fetchNext(layout.key, 0);
                    }
                    function fetchNext(lyKey, i) {
                        if (!layout || layout.key !== lyKey) return;   // superseded
                        var tiles = layout.tiles;
                        if (i >= tiles.length) return;
                        var t = tiles[i];
                        if (tileUris[t.id]) { fetchNext(lyKey, i + 1); return; }
                        logos.watch(root.backend.ensureTile(t.z, t.x, t.y),
                            function (url) {
                                if (layout && layout.key === lyKey && url && url.length > 0) {
                                    var mm = {};
                                    for (var k in tileUris) mm[k] = tileUris[k];
                                    mm[t.id] = url;
                                    tileUris = mm;      // new ref -> re-eval bindings
                                    // hasTiles is set only when a tile Image
                                    // actually loads (onStatusChanged below), so
                                    // a sandbox-blocked tile shows no attribution.
                                }
                                fetchNext(lyKey, i + 1);
                            },
                            function (e) { fetchNext(lyKey, i + 1); }); // keep going
                    }

                    onWidthChanged: rebuild()
                    onHeightChanged: rebuild()
                    Connections { target: root; function onTrackPointsChanged() { mapBox.rebuild(); } }

                    // Basemap tiles, positioned by the Mercator transform.
                    Repeater {
                        model: mapBox.layout ? mapBox.layout.tiles : []
                        delegate: Image {
                            x: modelData.sx
                            y: modelData.sy
                            width: mapBox.tileSize
                            height: mapBox.tileSize
                            asynchronous: true
                            cache: false
                            fillMode: Image.PreserveAspectCrop
                            source: mapBox.tileUris[modelData.id] || ""
                            visible: status === Image.Ready
                            // Only a genuinely loaded tile flips hasTiles → scrim
                            // + attribution appear only with a real basemap.
                            onStatusChanged: {
                                if (status === Image.Ready) mapBox.hasTiles = true;
                                else if (status === Image.Error)
                                    console.log("[perun] tile blocked/failed:", source);
                            }
                        }
                    }

                    // Dark scrim over the bright tiles so the orange track stays
                    // legible (only when tiles are actually shown).
                    Rectangle {
                        anchors.fill: parent
                        visible: mapBox.hasTiles
                        color: "#0d1013"
                        opacity: 0.45
                    }

                    // One Shape per segment: ShapePath isn't an Item, so a
                    // Repeater has to model the Shapes, not the paths.
                    Repeater {
                        model: mapBox.routeSegs
                        Shape {
                            anchors.fill: parent
                            ShapePath {
                                strokeColor: Theme.palette.primary
                                strokeWidth: 2.5
                                fillColor: "transparent"
                                capStyle: ShapePath.RoundCap
                                joinStyle: ShapePath.RoundJoin
                                PathPolyline { path: modelData }
                            }
                        }
                    }
                    Rectangle {
                        visible: mapBox.routePts.length > 1
                        width: 9; height: 9; radius: 5
                        color: Theme.palette.success
                        x: mapBox.startPt.x - 4; y: mapBox.startPt.y - 4
                    }
                    Rectangle {
                        visible: mapBox.routePts.length > 1
                        width: 9; height: 9; radius: 5
                        color: Theme.palette.error
                        x: mapBox.endPt.x - 4; y: mapBox.endPt.y - 4
                    }
                    LogosText {
                        anchors.centerIn: parent
                        visible: mapBox.routePts.length < 2
                        text: "no track"
                        color: Theme.palette.textTertiary
                        font.pixelSize: 12
                    }

                    // Annotation markers — a pin per annotation at its lat/lon, in
                    // the same Mercator frame as the track. Tapping one selects the
                    // matching list item (and vice-versa via selectedAnnotation).
                    Repeater {
                        model: root.annotations
                        delegate: Rectangle {
                            // Reference mapBox.layout so the position re-evaluates
                            // when the frame changes (pan/zoom/rebuild).
                            property point pp: (mapBox.layout, mapBox.project(modelData.lat, modelData.lon))
                            visible: mapBox.layout !== null
                            width: sel ? 22 : 18
                            height: width
                            radius: width / 2
                            property bool sel: index === root.selectedAnnotation
                            x: pp.x - width / 2
                            y: pp.y - height / 2
                            color: sel ? Theme.palette.primary : Theme.palette.backgroundElevated
                            border.width: 2
                            border.color: Theme.palette.primary
                            z: sel ? 2 : 1
                            LogosText {
                                anchors.centerIn: parent
                                text: root.iconForKind(modelData.kind)
                                font.pixelSize: parent.sel ? 12 : 10
                            }
                            MouseArea {
                                anchors.fill: parent
                                onClicked: root.selectedAnnotation = index
                            }
                        }
                    }

                    // OSM attribution — mandatory whenever tiles are drawn.
                    Rectangle {
                        visible: mapBox.hasTiles
                        anchors.right: parent.right
                        anchors.bottom: parent.bottom
                        anchors.margins: 3
                        radius: 3
                        color: "#8c0d1013"   // rgba(13,16,19,0.55)
                        width: attribLabel.implicitWidth + 8
                        height: attribLabel.implicitHeight + 4
                        LogosText {
                            id: attribLabel
                            anchors.centerIn: parent
                            text: "© OpenStreetMap contributors"
                            color: Theme.palette.text
                            font.pixelSize: 9
                        }
                    }

                    // ---- Replay: playhead + drag-scrub + side annotation panel ----
                    // Playhead ring travelling the route as you scrub.
                    Rectangle {
                        visible: root.replayMode && mapBox.layout !== null && root.trackPoints.length > root.headIdx
                        property point pp: (mapBox.layout, root.trackPoints.length ? mapBox.project(root.trackPoints[root.headIdx].lat, root.trackPoints[root.headIdx].lon) : Qt.point(-9999, -9999))
                        width: 16; height: 16; radius: 8
                        x: pp.x - 8; y: pp.y - 8
                        color: Theme.palette.primary
                        border.width: 2; border.color: Theme.palette.background
                        z: 5
                    }
                    // Drag anywhere on the map to move the playhead to the nearest track point.
                    MouseArea {
                        visible: root.replayMode
                        enabled: root.replayMode
                        anchors.fill: parent
                        z: 4
                        preventStealing: true
                        function scrubAt(mx, my) {
                            var p = root.trackPoints;
                            if (!p.length || !mapBox.layout) return;
                            var best = 0, bd = 1e18;
                            for (var i = 0; i < p.length; i++) {
                                var pt = mapBox.project(p[i].lat, p[i].lon);
                                var g = (pt.x - mx) * (pt.x - mx) + (pt.y - my) * (pt.y - my);
                                if (g < bd) { bd = g; best = i; }
                            }
                            root.headIdx = best;
                        }
                        onPressed: (m) => scrubAt(m.x, m.y)
                        onPositionChanged: (m) => { if (pressed) scrubAt(m.x, m.y); }
                    }
                    // Side panel — the annotation you're passing, with stats at this point.
                    Rectangle {
                        id: replayPanel
                        visible: root.replayMode
                        z: 6
                        anchors.right: parent.right
                        anchors.top: parent.top
                        anchors.bottom: parent.bottom
                        anchors.margins: 8
                        width: Math.min(360, parent.width * 0.45)
                        radius: Theme.spacing.radiusSmall
                        color: "#f20d1013"   // near-opaque panel over the map
                        border.width: 1
                        border.color: Theme.palette.borderHairline
                        property var fa: (root.featIdx >= 0 && root.annotations.length > root.featIdx) ? root.annotations[root.featIdx] : null
                        onFaChanged: if (fa && fa.blobId && (fa.kind === "photo" || fa.kind === "voice")) root.ensureMedia(fa.blobId, fa.mime)

                        ColumnLayout {
                            anchors.fill: parent
                            anchors.margins: 12
                            spacing: 8
                            LogosText {
                                Layout.fillWidth: true
                                text: root.fmtDist(root.headDist()) + "  ·  " + (root.trackPoints.length ? root.fmtDur((root.trackPoints[root.headIdx].t - root.trackPoints[0].t) / 1000) : "0:00")
                                color: Theme.palette.text; font.pixelSize: 15; font.bold: true
                            }
                            LogosText {
                                Layout.fillWidth: true
                                visible: root.trackPoints.length && root.trackPoints[root.headIdx].altValid
                                text: "Elevation " + root.fmtElev(root.trackPoints.length ? root.trackPoints[root.headIdx].alt : 0)
                                color: Theme.palette.textSecondary; font.pixelSize: 12
                            }
                            Rectangle { Layout.fillWidth: true; Layout.preferredHeight: 1; color: Theme.palette.borderHairline }
                            LogosText {
                                Layout.fillWidth: true
                                text: replayPanel.fa
                                    ? (root.iconForKind(replayPanel.fa.kind) + "  " + (root.featGap <= root.featThreshold ? "● at this point" : ("at " + root.fmtDist(root.annDistance(replayPanel.fa)))))
                                    : "No annotations — drag to replay the route."
                                color: Theme.palette.textSecondary; font.pixelSize: 12; wrapMode: Text.WordWrap
                            }
                            Image {
                                Layout.fillWidth: true
                                Layout.preferredHeight: 190
                                visible: replayPanel.fa && replayPanel.fa.kind === "photo"
                                fillMode: Image.PreserveAspectFit
                                source: (replayPanel.fa && root.mediaUrls[replayPanel.fa.blobId]) ? root.mediaUrls[replayPanel.fa.blobId] : ""
                            }
                            Rectangle {
                                Layout.fillWidth: true
                                Layout.preferredHeight: 40
                                visible: replayPanel.fa && replayPanel.fa.kind === "voice"
                                radius: Theme.spacing.radiusSmall
                                color: Theme.palette.backgroundInset
                                border.width: 1; border.color: Theme.palette.borderHairline
                                LogosText {
                                    anchors.centerIn: parent
                                    text: "▶  Play voice note"
                                    color: Theme.palette.primary; font.pixelSize: 13
                                }
                                MouseArea {
                                    anchors.fill: parent
                                    onClicked: if (replayPanel.fa) root.playVoice(replayPanel.fa.blobId, replayPanel.fa.mime)
                                }
                            }
                            LogosText {
                                Layout.fillWidth: true
                                visible: replayPanel.fa && replayPanel.fa.text
                                text: replayPanel.fa ? (replayPanel.fa.text || "") : ""
                                color: Theme.palette.text; font.pixelSize: 14; wrapMode: Text.WordWrap
                            }
                            Item { Layout.fillHeight: true }
                        }
                    }
                }

                // ---- Journey annotations: photos / voice notes / text comments
                //      the athlete pinned to a point, synced from mobile. ----
                RowLayout {
                    Layout.fillWidth: true
                    Layout.topMargin: Theme.spacing.small
                    LogosText {
                        text: "HIGHLIGHTS  ·  " + root.annotations.length
                        color: Theme.palette.textTertiary; font.pixelSize: 11
                    }
                    LogosText {
                        Layout.leftMargin: 12
                        text: root.replayMode ? "◉ Exit replay" : "▶ Replay"
                        color: Theme.palette.primary; font.pixelSize: 12
                        visible: root.selectedRun !== null && root.trackPoints.length >= 2
                        MouseArea { anchors.fill: parent; onClicked: root.replayMode = !root.replayMode }
                    }
                    Item { Layout.fillWidth: true }
                    // Desktop text authoring: pin a note to the run's start point.
                    LogosText {
                        text: annCompose.visible ? "" : "+ Note"
                        color: Theme.palette.primary; font.pixelSize: 12
                        visible: root.ready && root.selectedRun !== null && !annCompose.visible
                        MouseArea { anchors.fill: parent; onClicked: annCompose.visible = true }
                    }
                }
                // Media hub: this module serves phone-captured photos/voice on the LAN.
                // Show the URL so the user can set it as the phone's attachment server.
                LogosText {
                    Layout.fillWidth: true
                    visible: root.backend && root.backend.blobServerUrl && root.backend.blobServerUrl.length > 0
                    text: "📡 Media hub: " + (root.backend ? root.backend.blobServerUrl : "") + "  — set as the phone's attachment URL"
                    color: Theme.palette.textTertiary; font.pixelSize: 10; wrapMode: Text.WordWrap
                }
                // Compose row (hidden until "+ Note"). Authors an ANNOTATION{text}
                // over the same sealed channel as CHUNKs, pinned to the first GPS
                // point (or 0,0 if the track has not loaded).
                RowLayout {
                    id: annCompose
                    visible: false
                    Layout.fillWidth: true
                    spacing: Theme.spacing.small
                    TextField {
                        id: annField
                        Layout.fillWidth: true
                        placeholderText: "Add a note to this run…"
                        color: Theme.palette.text
                        font.pixelSize: 13
                        background: Rectangle {
                            color: Theme.palette.backgroundElevated
                            radius: Theme.spacing.radiusSmall
                            border.color: Theme.palette.borderHairline; border.width: 1
                        }
                        onAccepted: annCompose.submit()
                    }
                    LogosButton {
                        text: "Add"
                        enabled: annField.text.trim().length > 0
                        onClicked: annCompose.submit()
                    }
                    LogosButton {
                        text: "Cancel"
                        onClicked: { annField.text = ""; annCompose.visible = false }
                    }
                    function submit() {
                        if (!root.backend || !root.selectedRun) return;
                        var txt = annField.text.trim();
                        if (txt.length === 0) return;
                        var p = (root.trackPoints && root.trackPoints.length > 0) ? root.trackPoints[0] : null;
                        var lat = p ? p.lat : 0, lon = p ? p.lon : 0;
                        var hasEle = p && p.altValid;
                        var ele = (p && p.altValid) ? p.alt : 0;
                        var t = p ? p.t : 0;
                        logos.watch(root.backend.addTextAnnotation(root.selectedRun.id, lat, lon, ele, hasEle ? true : false, t, txt),
                            function () { annField.text = ""; annCompose.visible = false; },
                            function (e) { console.log("[perun] addTextAnnotation error:", e); });
                    }
                }
                ListView {
                    id: annList
                    visible: root.annotations.length > 0
                    Layout.fillWidth: true
                    Layout.preferredHeight: Math.min(3, root.annotations.length) * 64
                    clip: true
                    spacing: Theme.spacing.small
                    model: root.annotations
                    currentIndex: root.selectedAnnotation
                    delegate: Rectangle {
                        width: annList.width
                        height: 58
                        radius: Theme.spacing.radiusSmall
                        color: index === root.selectedAnnotation ? Theme.palette.overlayOrange : Theme.palette.backgroundElevated
                        border.width: index === root.selectedAnnotation ? 1 : 0
                        border.color: Theme.palette.primary
                        MouseArea { anchors.fill: parent; onClicked: root.selectedAnnotation = index }
                        RowLayout {
                            anchors.fill: parent
                            anchors.margins: Theme.spacing.small
                            spacing: Theme.spacing.medium

                            // Photo thumbnail (decrypted on demand) or a kind icon.
                            Item {
                                Layout.preferredWidth: 42
                                Layout.preferredHeight: 42
                                property string blobUrl: modelData.blobId ? (root.mediaUrls[modelData.blobId] || "") : ""
                                Component.onCompleted: if (modelData.kind === "photo" && modelData.blobId) root.ensureMedia(modelData.blobId, modelData.mime)
                                Rectangle {
                                    anchors.fill: parent
                                    radius: Theme.spacing.radiusSmall
                                    color: Theme.palette.backgroundSecondary
                                    LogosText {
                                        anchors.centerIn: parent
                                        text: root.iconForKind(modelData.kind)
                                        font.pixelSize: 18
                                        visible: thumb.status !== Image.Ready
                                    }
                                    Image {
                                        id: thumb
                                        anchors.fill: parent
                                        fillMode: Image.PreserveAspectCrop
                                        asynchronous: true
                                        cache: false
                                        visible: status === Image.Ready
                                        source: (modelData.kind === "photo" && parent.parent.blobUrl && parent.parent.blobUrl !== "error" && parent.parent.blobUrl !== "loading") ? parent.parent.blobUrl : ""
                                    }
                                    MouseArea {
                                        anchors.fill: parent
                                        enabled: modelData.kind === "photo"
                                        onClicked: {
                                            root.selectedAnnotation = index;
                                            if (modelData.blobId) photoView.show(modelData);
                                        }
                                    }
                                }
                            }

                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 2
                                LogosText {
                                    Layout.fillWidth: true
                                    text: modelData.text && modelData.text.length > 0
                                          ? modelData.text
                                          : (modelData.kind === "photo" ? "Photo"
                                             : (modelData.kind === "voice" ? "Voice note" : "Note"))
                                    color: Theme.palette.text; font.pixelSize: 13
                                    elide: Text.ElideRight
                                }
                                LogosText {
                                    text: {
                                        var d = new Date(modelData.t || modelData.createdAt || 0);
                                        var hh = d.getHours(), mm = d.getMinutes();
                                        var stamp = (hh < 10 ? "0" + hh : hh) + ":" + (mm < 10 ? "0" + mm : mm);
                                        var extra = modelData.kind === "voice" && modelData.dur ? "  ·  " + Math.round(modelData.dur) + "s" : "";
                                        return root.iconForKind(modelData.kind) + "  " + stamp + extra;
                                    }
                                    color: Theme.palette.textTertiary; font.pixelSize: 11
                                }
                            }

                            // Voice: load + play through the isolated VoicePlayer
                            // (QtMultimedia lives in that file, so if the runtime
                            // lacks it only this control degrades, not the view).
                            LogosButton {
                                visible: modelData.kind === "voice"
                                text: {
                                    var u = modelData.blobId ? root.mediaUrls[modelData.blobId] : "";
                                    return u === "loading" ? "…" : (u === "error" ? "retry" : "▶");
                                }
                                onClicked: {
                                    root.selectedAnnotation = index;
                                    if (modelData.blobId) root.playVoice(modelData.blobId, modelData.mime);
                                }
                            }
                        }
                    }
                }

                // ---- Elevation profile — altitude over cumulative distance,
                //      matching the mobile ElevationChart (skips no-fix points,
                //      light moving-average smoothing). ----
                LogosText {
                    visible: elevBox.hasData
                    text: "ELEVATION" + (root.selectedRun ? "  ·  +" + root.fmtElev(root.selectedRun.summary.elevGainM) : "")
                    color: Theme.palette.textTertiary; font.pixelSize: 11
                    Layout.topMargin: Theme.spacing.small
                }
                Rectangle {
                    id: elevBox
                    visible: hasData
                    Layout.fillWidth: true
                    Layout.preferredHeight: 110
                    radius: Theme.spacing.radiusSmall
                    color: Theme.palette.backgroundElevated
                    border.color: Theme.palette.borderHairline
                    border.width: 1
                    clip: true
                    // True when the selected run has at least one real altitude
                    // sample (re-evaluates when trackPoints changes).
                    property bool hasData: {
                        var pts = root.trackPoints || [];
                        for (var i = 0; i < pts.length; i++) if (pts[i].altValid) return true;
                        return false;
                    }
                    onWidthChanged: elevCanvas.requestPaint()
                    onHasDataChanged: elevCanvas.requestPaint()
                    // Repaint when a different run's track loads (the map uses the
                    // same pattern; hasData alone wouldn't fire run-to-run).
                    Connections { target: root; function onTrackPointsChanged() { elevCanvas.requestPaint(); } }
                    Canvas {
                        id: elevCanvas
                        anchors.fill: parent
                        anchors.margins: 4
                        onPaint: {
                            var ctx = getContext("2d");
                            ctx.reset();
                            var Wd = width, Hd = height;
                            var pts = root.trackPoints || [];
                            var raw = [], dist = 0;
                            for (var i = 0; i < pts.length; i++) {
                                if (i > 0 && !pts[i].brk)
                                    dist += root.haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
                                if (pts[i].altValid) raw.push({ d: dist, a: pts[i].alt });
                            }
                            if (raw.length < 2) return;
                            // light centred moving average (±2 samples)
                            var series = [];
                            for (var i = 0; i < raw.length; i++) {
                                var sum = 0, n = 0;
                                for (var j = Math.max(0, i-2); j <= Math.min(raw.length-1, i+2); j++) { sum += raw[j].a; n++; }
                                series.push({ d: raw[i].d, a: sum / n });
                            }
                            var minA = series[0].a, maxA = series[0].a, maxD = series[series.length-1].d;
                            for (var i = 0; i < series.length; i++) {
                                if (series[i].a < minA) minA = series[i].a;
                                if (series[i].a > maxA) maxA = series[i].a;
                            }
                            var spanA = Math.max(1, maxA - minA); maxD = Math.max(1, maxD);
                            var pad = 6;
                            function X(d) { return pad + (d / maxD) * (Wd - 2*pad); }
                            function Y(a) { return Hd - pad - ((a - minA) / spanA) * (Hd - 2*pad); }
                            ctx.strokeStyle = Theme.palette.borderHairline; ctx.lineWidth = 1;
                            ctx.beginPath(); ctx.moveTo(pad, Hd - pad); ctx.lineTo(Wd - pad, Hd - pad); ctx.stroke();
                            ctx.beginPath(); ctx.moveTo(X(0), Hd - pad);
                            for (var i = 0; i < series.length; i++) ctx.lineTo(X(series[i].d), Y(series[i].a));
                            ctx.lineTo(X(maxD), Hd - pad); ctx.closePath();
                            ctx.globalAlpha = 0.13; ctx.fillStyle = Theme.palette.primary; ctx.fill(); ctx.globalAlpha = 1.0;
                            ctx.beginPath();
                            for (var i = 0; i < series.length; i++) {
                                var x = X(series[i].d), y = Y(series[i].a);
                                if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                            }
                            ctx.strokeStyle = Theme.palette.primary; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
                            ctx.fillStyle = Theme.palette.textTertiary; ctx.font = "10px sans-serif";
                            ctx.textAlign = "right";
                            ctx.fillText(Math.round(maxA) + " m", Wd - pad, 11);
                            ctx.fillText(Math.round(minA) + " m", Wd - pad, Hd - pad - 3);
                            ctx.textAlign = "left";
                            ctx.fillText("+" + Math.round(maxA - minA) + " m", pad, Hd - pad - 3);
                            // Replay playhead — a vertical marker on the full-route distance axis.
                            if (root.replayMode && root.totalDist > 0) {
                                var hx = pad + (root.headDist() / root.totalDist) * (Wd - 2 * pad);
                                ctx.strokeStyle = Theme.palette.text; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85;
                                ctx.beginPath(); ctx.moveTo(hx, pad); ctx.lineTo(hx, Hd - pad); ctx.stroke();
                                ctx.globalAlpha = 1.0;
                            }
                        }
                    }
                    // Repaint the elevation playhead when it moves / mode toggles.
                    Connections { target: root; function onHeadIdxChanged() { elevCanvas.requestPaint(); } }
                    Connections { target: root; function onReplayModeChanged() { elevCanvas.requestPaint(); } }
                    // Drag the elevation strip to scrub (shares the full-route distance axis).
                    MouseArea {
                        visible: root.replayMode
                        enabled: root.replayMode
                        anchors.fill: parent
                        z: 3
                        preventStealing: true
                        function scrub(mx) {
                            var pad = 6;
                            var frac = Math.max(0, Math.min(1, (mx - pad) / Math.max(1, width - 2 * pad)));
                            root.headIdx = root.nearestIdxToDist(frac * root.totalDist);
                        }
                        onPressed: (m) => scrub(m.x)
                        onPositionChanged: (m) => { if (pressed) scrub(m.x); }
                    }
                }

                // Splits header
                RowLayout {
                    Layout.fillWidth: true
                    LogosText { text: "KM"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 40 }
                    LogosText {
                        text: root.sportInfo(root.selectedRun ? root.selectedRun.sport : "").foot ? "PACE" : "SPEED"
                        color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 90
                    }
                    LogosText { text: "ELEV"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 70 }
                    LogosText { text: "HR"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Item { Layout.fillWidth: true }
                }

                ListView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    model: root.selectedRun ? root.selectedRun.splits : []
                    delegate: RowLayout {
                        width: ListView.view ? ListView.view.width : 0
                        height: 26
                        LogosText { text: "" + modelData.index; color: Theme.palette.text; font.pixelSize: 13; Layout.preferredWidth: 40 }
                        LogosText {
                            text: root.fmtRate(modelData.paceSecPerKm,
                                               root.sportInfo(root.selectedRun ? root.selectedRun.sport : "").foot)
                            color: Theme.palette.text; font.pixelSize: 13; Layout.preferredWidth: 90
                        }
                        LogosText { text: "+" + root.fmtElev(modelData.elevGainM); color: Theme.palette.textSecondary; font.pixelSize: 13; Layout.preferredWidth: 70 }
                        LogosText { text: modelData.avgHr > 0 ? Math.round(modelData.avgHr) : "—"; color: Theme.palette.textSecondary; font.pixelSize: 13; Layout.preferredWidth: 50 }
                        Rectangle {
                            Layout.fillWidth: true
                            height: 10
                            radius: 3
                            color: Theme.palette.backgroundSecondary
                            Rectangle {
                                height: parent.height; radius: 3
                                width: Math.max(4, parent.width * Math.min(1, (modelData.distanceM || 0) / 1000))
                                color: Theme.palette.primary
                            }
                        }
                    }
                }
            }

            LogosText {
                anchors.centerIn: parent
                visible: root.selectedRun === null && !root.showTrends
                text: "Select a run to see its details"
                color: Theme.palette.textTertiary
                font.pixelSize: 14
            }

            // ---- Trends dashboard: all-time totals, weekly distance bars, and
            //      personal bests — aggregated across every run. ----
            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.medium
                visible: root.showTrends

                LogosText { text: "Trends"; color: Theme.palette.text; font.pixelSize: 20; font.weight: Theme.typography.weightMedium }

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.large
                    Repeater {
                        model: {
                            var t = root.trendTotals();
                            var hrs = t.dur / 3600;
                            return [
                                { k: "Runs", v: "" + t.runs },
                                { k: "Distance", v: (t.dist / 1000).toFixed(1) + " km" },
                                { k: "Time", v: (hrs >= 1 ? hrs.toFixed(1) + " h" : Math.round(t.dur / 60) + " min") },
                                { k: "Elevation", v: Math.round(t.elev) + " m" }
                            ];
                        }
                        delegate: ColumnLayout {
                            spacing: 2
                            LogosText { text: modelData.k; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                            LogosText { text: modelData.v; color: Theme.palette.text; font.pixelSize: 20; font.weight: Theme.typography.weightMedium }
                        }
                    }
                    Item { Layout.fillWidth: true }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline }

                LogosText { text: "WEEKLY DISTANCE  ·  last 12 weeks (km)"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                Rectangle {
                    id: weekBox
                    Layout.fillWidth: true
                    Layout.preferredHeight: 170
                    radius: Theme.spacing.radiusSmall
                    color: Theme.palette.backgroundElevated
                    border.color: Theme.palette.borderHairline
                    border.width: 1
                    clip: true
                    property var bars: root.showTrends ? root.weeklyBars(12) : []
                    onBarsChanged: weekCanvas.requestPaint()
                    onWidthChanged: weekCanvas.requestPaint()
                    Canvas {
                        id: weekCanvas
                        anchors.fill: parent
                        anchors.margins: 6
                        onPaint: {
                            var ctx = getContext("2d"); ctx.reset();
                            var Wd = width, Hd = height;
                            var bars = weekBox.bars || [];
                            if (bars.length === 0) return;
                            var maxV = 0;
                            for (var i = 0; i < bars.length; i++) if (bars[i].dist > maxV) maxV = bars[i].dist;
                            var labelH = 14, topPad = 14, chartH = Hd - labelH - topPad;
                            var gap = 6, bw = (Wd - gap * (bars.length - 1)) / bars.length;
                            ctx.font = "9px sans-serif"; ctx.textAlign = "center";
                            for (var i = 0; i < bars.length; i++) {
                                var x = i * (bw + gap);
                                var h = maxV > 0 ? (bars[i].dist / maxV) * chartH : 0;
                                var y = topPad + (chartH - h);
                                ctx.fillStyle = Theme.palette.primary;
                                ctx.globalAlpha = bars[i].dist > 0 ? 1.0 : 0.22;
                                ctx.fillRect(x, y, bw, Math.max(bars[i].dist > 0 ? 2 : 1, h));
                                ctx.globalAlpha = 1.0;
                                if (bars[i].dist > 0) {
                                    ctx.fillStyle = Theme.palette.textSecondary;
                                    ctx.fillText((bars[i].dist / 1000).toFixed(0), x + bw / 2, y - 3);
                                }
                                ctx.fillStyle = Theme.palette.textTertiary;
                                if (i % 2 === (bars.length % 2)) ctx.fillText(bars[i].label, x + bw / 2, Hd - 3);
                            }
                        }
                    }
                }

                Rectangle { Layout.fillWidth: true; height: 1; color: Theme.palette.borderHairline }

                LogosText { text: "PERSONAL BESTS"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                Repeater {
                    model: {
                        var pb = root.personalBests(), rows = [];
                        if (pb.longest) rows.push({ k: "Longest run", v: root.fmtDist(pb.longest.summary.distanceM), sub: pb.longest.name || "" });
                        if (pb.climb && pb.climb.summary.elevGainM > 0) rows.push({ k: "Biggest climb", v: "+" + root.fmtElev(pb.climb.summary.elevGainM), sub: pb.climb.name || "" });
                        if (pb.fastest) rows.push({ k: "Fastest pace", v: root.fmtPace(pb.fastest.summary.avgPaceSecPerKm), sub: pb.fastest.name || "" });
                        return rows;
                    }
                    delegate: RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.spacing.medium
                        ColumnLayout {
                            Layout.fillWidth: true
                            spacing: 1
                            LogosText { text: modelData.k; color: Theme.palette.textSecondary; font.pixelSize: 13 }
                            LogosText { text: modelData.sub; color: Theme.palette.textTertiary; font.pixelSize: 11; elide: Text.ElideRight; Layout.fillWidth: true }
                        }
                        LogosText { text: modelData.v; color: Theme.palette.primary; font.pixelSize: 16; font.weight: Theme.typography.weightMedium }
                    }
                }

                Item { Layout.fillHeight: true }
            }
        }

        } // SplitView

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.spacing.medium
            LogosButton {
                text: "Publish sample run"
                enabled: root.ready
                onClicked: logos.watch(backend.publishSampleRun(), function () {}, function (e) { console.log("publish error:", e); });
            }
            LogosButton {
                text: "Export GPX"
                enabled: root.selectedRun !== null
                onClicked: logos.watch(backend.exportGpx(root.selectedRun.id),
                                       function (path) { console.log("exported:", path); },
                                       function (e) { console.log("export error:", e); });
            }
            Item { Layout.fillWidth: true }
            LogosButton {
                text: "Pair phone"
                enabled: root.backend !== null
                onClicked: pairDialog.open()
            }
        }
    }

    // ---- Photo viewer: full-size decrypted image + its caption ----
    Popup {
        id: photoView
        anchors.centerIn: Overlay.overlay
        modal: true
        padding: Theme.spacing.large
        property var ann: null
        property string blobId: ann && ann.blobId ? ann.blobId : ""
        property string url: blobId ? (root.mediaUrls[blobId] || "") : ""
        // `show` (not `open`) so we don't shadow Popup's built-in open().
        function show(a) { photoView.ann = a; if (a && a.blobId) root.ensureMedia(a.blobId, a.mime); photoView.open(); }
        background: Rectangle {
            color: Theme.palette.backgroundInset
            radius: Theme.spacing.radiusMedium
            border.color: Theme.palette.borderHairline; border.width: 1
        }
        ColumnLayout {
            width: 460
            spacing: Theme.spacing.medium
            Rectangle {
                Layout.fillWidth: true
                Layout.preferredHeight: 340
                radius: Theme.spacing.radiusSmall
                color: Theme.palette.backgroundElevated
                clip: true
                Image {
                    anchors.fill: parent
                    anchors.margins: 2
                    fillMode: Image.PreserveAspectFit
                    asynchronous: true
                    cache: false
                    source: (photoView.url && photoView.url !== "error" && photoView.url !== "loading") ? photoView.url : ""
                    visible: status === Image.Ready
                }
                LogosText {
                    anchors.centerIn: parent
                    visible: photoView.url === "" || photoView.url === "loading"
                    text: "loading photo…"
                    color: Theme.palette.textTertiary; font.pixelSize: 13
                }
                LogosText {
                    anchors.centerIn: parent
                    visible: photoView.url === "error"
                    text: "Photo unavailable\n(blob server unreachable)"
                    horizontalAlignment: Text.AlignHCenter
                    color: Theme.palette.warning; font.pixelSize: 13
                }
            }
            LogosText {
                Layout.fillWidth: true
                visible: photoView.ann && photoView.ann.text && photoView.ann.text.length > 0
                text: photoView.ann ? (photoView.ann.text || "") : ""
                color: Theme.palette.text; font.pixelSize: 13; wrapMode: Text.Wrap
            }
            RowLayout {
                Layout.fillWidth: true
                Item { Layout.fillWidth: true }
                LogosButton { text: "Close"; onClicked: photoView.close() }
            }
        }
    }

    // ---- Pairing: show the QR the phone scans + the confirm words ----
    Popup {
        id: pairDialog
        anchors.centerIn: Overlay.overlay
        modal: true
        padding: Theme.spacing.large
        background: Rectangle {
            color: Theme.palette.backgroundInset
            radius: Theme.spacing.radiusMedium
            border.color: Theme.palette.borderHairline
            border.width: 1
        }
        // QR is generated IN-PROCESS by the backend (vendored qrcodegen) — no
        // external qr module, no cross-module IPC. qrMatrix returns {ok,n,cells}.
        property int qrN: 0
        property var qrCells: []
        function genQr() {
            pairDialog.qrN = 0; pairDialog.qrCells = [];
            if (!root.backend || !root.backend.pairingUri) { console.log("[perun] genQr: no backend/pairingUri"); return; }
            logos.watch(root.backend.qrMatrix(root.backend.pairingUri),
                function (json) {
                    var r = JSON.parse(json || "{}");
                    console.log("[perun] qrMatrix ->", json ? json.length : 0, "bytes, ok=", (r && r.ok), "n=", (r && r.n));
                    if (r && r.ok) { pairDialog.qrN = r.n; pairDialog.qrCells = r.cells; qrCanvas.requestPaint(); }
                },
                function (e) { console.log("[perun] qrMatrix error:", e); });
        }
        onOpened: genQr()

        ColumnLayout {
            width: 320
            spacing: Theme.spacing.medium

            LogosText {
                Layout.alignment: Qt.AlignHCenter
                text: "Pair Perun"
                color: Theme.palette.text
                font.pixelSize: 16
                font.weight: Theme.typography.weightMedium
            }
            LogosText {
                Layout.alignment: Qt.AlignHCenter
                text: "Scan with the Perun app to sync your runs privately"
                color: Theme.palette.textSecondary
                font.pixelSize: 12
            }

            // The QR: drawn directly on a Canvas from the backend matrix (no
            // Repeater, no per-cell items — one paint pass, sandbox-safe).
            Rectangle {
                Layout.alignment: Qt.AlignHCenter
                width: 220; height: 220
                color: "white"
                radius: 4
                Canvas {
                    id: qrCanvas
                    anchors.fill: parent
                    onPaint: {
                        var ctx = getContext("2d");
                        ctx.fillStyle = "white";
                        ctx.fillRect(0, 0, width, height);
                        var n = pairDialog.qrN;
                        var cells = pairDialog.qrCells;
                        if (n <= 0 || !cells || cells.length < n * n) return;
                        var margin = 10;
                        var cell = (width - 2 * margin) / n;
                        ctx.fillStyle = "black";
                        for (var i = 0; i < n * n; i++) {
                            if (cells[i] === 1) {
                                var cx = i % n, cy = Math.floor(i / n);
                                ctx.fillRect(margin + cx * cell, margin + cy * cell,
                                             Math.ceil(cell), Math.ceil(cell));
                            }
                        }
                    }
                }
                LogosText {
                    anchors.centerIn: parent
                    visible: pairDialog.qrN === 0
                    text: "generating…"
                    color: "#888"
                    font.pixelSize: 13
                }
            }

            LogosText {
                Layout.alignment: Qt.AlignHCenter
                text: root.backend ? ("Confirm these words match the app: " + root.backend.fingerprint) : ""
                color: Theme.palette.textSecondary
                font.pixelSize: 12
            }
            // Fallback that never depends on the qr module: paste this link into
            // the Perun app's manual-pairing field.
            LogosText {
                Layout.fillWidth: true
                text: "Or paste this link into the Perun app:"
                color: Theme.palette.textTertiary
                font.pixelSize: 11
            }
            TextEdit {
                Layout.fillWidth: true
                text: root.backend ? root.backend.pairingUri : ""
                readOnly: true
                selectByMouse: true
                wrapMode: TextEdit.WrapAnywhere
                color: Theme.palette.text
                selectionColor: Theme.palette.primary
                font.pixelSize: 11
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: Theme.spacing.medium
                LogosButton {
                    text: "Reset pairing"
                    onClicked: logos.watch(root.backend.resetPairing(),
                                           function () {}, function (e) { console.log("reset error:", e); });
                }
                Item { Layout.fillWidth: true }
                LogosButton { text: "Close"; onClicked: pairDialog.close() }
            }
        }
    }
}
