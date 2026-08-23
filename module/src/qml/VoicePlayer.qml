// Isolated voice-note player. QtMultimedia is imported ONLY here so a runtime
// that lacks the module fails just this Loader (Main.qml checks Loader.Error and
// degrades the play button) instead of failing the whole view to load.
import QtQuick
import QtMultimedia

Item {
    id: vp
    // Toggle-play the given file:// url: play if idle/different, pause if playing.
    function play(url) {
        if (mp.source != url) {
            mp.stop();
            mp.source = url;
            mp.play();
        } else if (mp.playbackState === MediaPlayer.PlayingState) {
            mp.pause();
        } else {
            mp.play();
        }
    }

    MediaPlayer {
        id: mp
        audioOutput: AudioOutput {}
        onErrorOccurred: function (err, str) { console.log("[perun] voice play error:", str); }
    }
}
