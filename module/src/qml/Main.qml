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
            text: backend && backend.topic ? ("topic: " + backend.topic) : ""
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

                // Route map — vector polyline via QtQuick.Shapes (no tiles/network).
                Rectangle {
                    id: mapBox
                    Layout.fillWidth: true
                    Layout.preferredHeight: 210
                    radius: Theme.spacing.radiusSmall
                    color: Theme.palette.backgroundElevated
                    border.color: Theme.palette.borderHairline
                    border.width: 1
                    clip: true

                    property var routePts: []
                    property point startPt: Qt.point(0, 0)
                    property point endPt: Qt.point(0, 0)

                    function project() {
                        var pts = root.trackPoints;
                        if (!pts || pts.length < 2 || width <= 0 || height <= 0) { routePts = []; return; }
                        var latMin = 1e9, latMax = -1e9, lonMin = 1e9, lonMax = -1e9;
                        for (var i = 0; i < pts.length; i++) {
                            var p = pts[i];
                            if (p.lat < latMin) latMin = p.lat;
                            if (p.lat > latMax) latMax = p.lat;
                            if (p.lon < lonMin) lonMin = p.lon;
                            if (p.lon > lonMax) lonMax = p.lon;
                        }
                        var m = 12;
                        var cosLat = Math.cos(((latMin + latMax) / 2) * Math.PI / 180);
                        var spanX = Math.max(1e-9, (lonMax - lonMin) * cosLat);
                        var spanY = Math.max(1e-9, (latMax - latMin));
                        var scale = Math.min((width - 2 * m) / spanX, (height - 2 * m) / spanY);
                        var drawW = spanX * scale, drawH = spanY * scale;
                        var ox = (width - drawW) / 2, oy = (height - drawH) / 2;
                        var out = [];
                        for (i = 0; i < pts.length; i++) {
                            out.push(Qt.point(ox + (pts[i].lon - lonMin) * cosLat * scale,
                                              oy + drawH - (pts[i].lat - latMin) * scale));
                        }
                        routePts = out;
                        startPt = out[0];
                        endPt = out[out.length - 1];
                    }
                    onWidthChanged: project()
                    onHeightChanged: project()
                    Connections { target: root; function onTrackPointsChanged() { mapBox.project(); } }

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
        }
    }
}
