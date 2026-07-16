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

    // Decoded points for the selected run's route map (fetched on demand).
    property var trackPoints: []

    Connections {
        target: logos
        function onViewModuleReadyChanged(moduleName, isReady) {
            if (moduleName === "perun_analytics")
                root.ready = isReady && root.backend !== null;
        }
    }
    Component.onCompleted: {
        root.ready = root.backend !== null && logos.isViewModuleReady("perun_analytics");
        // Cache OSM tiles under the plugin's own qml dir — the only place the
        // Basecamp QML sandbox lets Image load files from.
        if (backend) logos.watch(backend.setTileRoot(Qt.resolvedUrl(".")), function () {}, function () {});
        fetchTrack();
    }

    onSelectedRunChanged: fetchTrack()

    function fetchTrack() {
        if (!backend || !selectedRun) { root.trackPoints = []; return; }
        logos.watch(backend.trackJson(selectedRun.id),
                    function (json) { root.trackPoints = JSON.parse(json || "[]"); mapCanvas.requestPaint(); },
                    function (e) { root.trackPoints = []; mapCanvas.requestPaint(); });
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

        // ---- Run list (master) ----
        Rectangle {
            Layout.fillWidth: true
            Layout.preferredHeight: 150
            color: Theme.palette.backgroundInset
            radius: Theme.spacing.radiusMedium
            border.color: Theme.palette.borderHairline
            border.width: 1

            ListView {
                id: runList
                anchors.fill: parent
                anchors.margins: Theme.spacing.small
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
                    MouseArea { anchors.fill: parent; onClicked: root.selectedIndex = index }
                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: Theme.spacing.medium
                        spacing: Theme.spacing.medium
                        ColumnLayout {
                            spacing: 2
                            LogosText { text: modelData.name || modelData.id; color: Theme.palette.text; font.pixelSize: 15 }
                            LogosText {
                                text: root.fmtDist(modelData.summary ? modelData.summary.distanceM : 0)
                                      + "  ·  " + root.fmtDur(modelData.summary ? modelData.summary.durationS : 0)
                                color: Theme.palette.textSecondary; font.pixelSize: 12
                            }
                        }
                        Item { Layout.fillWidth: true }
                        LogosText {
                            text: root.fmtPace(modelData.summary ? modelData.summary.avgPaceSecPerKm : 0)
                            color: Theme.palette.textSecondary; font.pixelSize: 13
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

        // ---- Detail: summary tiles + route map + splits ----
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
            color: Theme.palette.backgroundInset
            radius: Theme.spacing.radiusMedium
            border.color: Theme.palette.borderHairline
            border.width: 1

            ColumnLayout {
                anchors.fill: parent
                anchors.margins: Theme.spacing.medium
                spacing: Theme.spacing.small
                visible: root.selectedRun !== null

                // Summary tiles
                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.spacing.medium
                    Repeater {
                        model: root.selectedRun ? [
                            { k: "Distance", v: root.fmtDist(root.selectedRun.summary.distanceM) },
                            { k: "Time",     v: root.fmtDur(root.selectedRun.summary.durationS) },
                            { k: "Avg pace", v: root.fmtPace(root.selectedRun.summary.avgPaceSecPerKm) },
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
                    Layout.preferredHeight: 210
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

                    function rebuild() {
                        var pts = root.trackPoints;
                        hasTiles = false;
                        tileUris = {};
                        if (!pts || pts.length < 2 || width <= 0 || height <= 0) {
                            layout = null; routePts = []; return;
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
                        for (i = 0; i < pts.length; i++)
                            out.push(Qt.point(originX + mercX(pts[i].lon) * scale,
                                              originY + mercY(pts[i].lat) * scale));
                        routePts = out;
                        startPt = out[0];
                        endPt = out[out.length - 1];

                        // Tiles are fetched by the C++ backend (which has network)
                        // and cached under the plugin's qml dir (setTileRoot), the
                        // one place the QML sandbox can load Image files from.
                        fetchTiles();
                    }

                    // Drive tile fetches one at a time: the backend blocks its
                    // (separate-process) thread per fetch, so a single in-flight
                    // request means no nested event loops there. Cached after the
                    // first load, so re-opening a run is instant.
                    function fetchTiles() {
                        if (layout && root.backend) fetchNext(layout.key, 0);
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

                    Shape {
                        anchors.fill: parent
                        ShapePath {
                            strokeColor: Theme.palette.primary
                            strokeWidth: 2.5
                            fillColor: "transparent"
                            capStyle: ShapePath.RoundCap
                            joinStyle: ShapePath.RoundJoin
                            PathPolyline { path: mapBox.routePts }
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
                }

                // Splits header
                RowLayout {
                    Layout.fillWidth: true
                    LogosText { text: "KM"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 40 }
                    LogosText { text: "PACE"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 90 }
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
                        LogosText { text: root.fmtPace(modelData.paceSecPerKm); color: Theme.palette.text; font.pixelSize: 13; Layout.preferredWidth: 90 }
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
                visible: root.selectedRun === null
                text: "Select a run to see splits"
                color: Theme.palette.textTertiary
                font.pixelSize: 14
            }
        }

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
