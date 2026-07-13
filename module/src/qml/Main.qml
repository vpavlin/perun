import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

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

    Connections {
        target: logos
        function onViewModuleReadyChanged(moduleName, isReady) {
            if (moduleName === "perun_analytics")
                root.ready = isReady && root.backend !== null;
        }
    }
    Component.onCompleted: root.ready = root.backend !== null && logos.isViewModuleReady("perun_analytics");

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
            Layout.preferredHeight: 170
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
                    color: Theme.palette.textTertiary
                    font.pixelSize: 14
                }
            }
        }

        // ---- Detail: summary tiles + splits (detail) ----
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

                // Splits header
                RowLayout {
                    Layout.fillWidth: true
                    LogosText { text: "KM"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 40 }
                    LogosText { text: "PACE"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 90 }
                    LogosText { text: "ELEV"; color: Theme.palette.textTertiary; font.pixelSize: 11; Layout.preferredWidth: 70 }
                    LogosText { text: "HR"; color: Theme.palette.textTertiary; font.pixelSize: 11 }
                    Item { Layout.fillWidth: true }
                }

                // Splits list with a pace bar
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
                        // relative pace bar (faster = longer, primary color)
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

        LogosButton {
            text: "Publish sample run"
            enabled: root.ready
            onClicked: logos.watch(backend.publishSampleRun(), function () {}, function (e) { console.log("publish error:", e); });
        }
    }
}
