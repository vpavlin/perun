import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

import Logos.Theme
import Logos.Controls

Item {
    id: root

    // Typed replica of the backend (see perun_analytics.rep).
    readonly property var backend: logos.module("perun_analytics")
    property bool ready: false
    readonly property string status: backend ? backend.status : ""
    readonly property var runs: backend ? JSON.parse(backend.runsJson || "[]") : []

    Connections {
        target: logos
        function onViewModuleReadyChanged(moduleName, isReady) {
            if (moduleName === "perun_analytics")
                root.ready = isReady && root.backend !== null;
        }
    }
    Component.onCompleted: {
        root.ready = root.backend !== null && logos.isViewModuleReady("perun_analytics");
    }

    // The host window is transparent underneath — paint our own surface.
    Rectangle {
        anchors.fill: parent
        color: Theme.palette.background
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.spacing.large
        spacing: Theme.spacing.medium

        LogosText {
            text: "Perun — Runs"
            color: Theme.palette.text
            font.pixelSize: 22
            font.weight: Theme.typography.weightMedium
        }

        LogosText {
            text: root.ready ? ("Connected · " + root.status) : "Connecting to backend…"
            color: root.ready ? Theme.palette.success : Theme.palette.warning
            font.pixelSize: 13
        }

        // Runs list
        Rectangle {
            Layout.fillWidth: true
            Layout.fillHeight: true
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
                    height: 60
                    color: Theme.palette.backgroundSecondary
                    radius: Theme.spacing.radiusSmall

                    RowLayout {
                        anchors.fill: parent
                        anchors.margins: Theme.spacing.medium
                        spacing: Theme.spacing.medium

                        ColumnLayout {
                            spacing: 2
                            LogosText {
                                text: modelData.name || modelData.id
                                color: Theme.palette.text
                                font.pixelSize: 15
                            }
                            LogosText {
                                text: (((modelData.distanceM || 0) / 1000).toFixed(2)) + " km"
                                color: Theme.palette.textSecondary
                                font.pixelSize: 12
                            }
                        }
                        Item { Layout.fillWidth: true }
                        LogosText {
                            text: {
                                var p = modelData.avgPaceSecPerKm || 0;
                                var m = Math.floor(p / 60), s = Math.round(p % 60);
                                return p > 0 ? (m + ":" + (s < 10 ? "0" + s : s) + " /km") : "";
                            }
                            color: Theme.palette.textSecondary
                            font.pixelSize: 13
                        }
                    }
                }

                // Empty state
                LogosText {
                    anchors.centerIn: parent
                    visible: root.runs.length === 0
                    text: "No runs yet"
                    color: Theme.palette.textTertiary
                    font.pixelSize: 14
                }
            }
        }

        // Test hook until Delivery is wired: inject a sample run.
        LogosButton {
            text: "Add sample run"
            enabled: root.ready
            onClicked: {
                var i = root.runs.length + 1;
                var sample = {
                    id: "sample-" + i,
                    name: "Sample run " + i,
                    startTs: Date.now(),
                    distanceM: 4000 + i * 1200,
                    durationS: 1500 + i * 300,
                    avgPaceSecPerKm: 300 + (i % 5) * 8
                };
                logos.watch(backend.ingestRun(JSON.stringify(sample)),
                            function () {},
                            function (e) { console.log("ingestRun error:", e); });
            }
        }
    }
}
