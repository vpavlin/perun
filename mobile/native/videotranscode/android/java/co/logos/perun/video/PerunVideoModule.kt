package co.logos.perun.video

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

// Re-encodes the Replay's WebM (VP8/Opus from the WebView's MediaRecorder) to an MP4
// (H.264/AAC) with the phone's hardware encoder via Media3 Transformer: several times
// smaller, and an MP4 is what WhatsApp/Instagram/most players accept (WebM often isn't).
// Transformer must be driven from a Looper thread, so everything runs on the main looper.
class PerunVideoModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "PerunVideo"

  private val main = Handler(Looper.getMainLooper())

  @ReactMethod
  fun toMp4(inPath: String, outPath: String, bitrate: Double, promise: Promise) {
    main.post {
      try {
        val inFile = File(Uri.parse(inPath).path ?: inPath)
        val outFile = File(Uri.parse(outPath).path ?: outPath)
        outFile.parentFile?.mkdirs()
        if (outFile.exists()) outFile.delete()
        val encoders = DefaultEncoderFactory.Builder(ctx)
          .setRequestedVideoEncoderSettings(
            VideoEncoderSettings.Builder().setBitrate(bitrate.toInt()).build()
          )
          .setEnableFallback(true)
          .build()
        val t0 = System.currentTimeMillis()
        val transformer = Transformer.Builder(ctx)
          .setVideoMimeType(MimeTypes.VIDEO_H264)
          .setAudioMimeType(MimeTypes.AUDIO_AAC)
          .setEncoderFactory(encoders)
          .addListener(object : Transformer.Listener {
            override fun onCompleted(composition: Composition, result: ExportResult) {
              val r = Arguments.createMap()
              r.putString("uri", Uri.fromFile(outFile).toString())
              r.putDouble("bytes", outFile.length().toDouble())
              r.putDouble("ms", (System.currentTimeMillis() - t0).toDouble())
              promise.resolve(r)
            }
            override fun onError(composition: Composition, result: ExportResult, e: ExportException) {
              outFile.delete()
              promise.reject("perun_video_mp4", e.message ?: "transcode failed", e)
            }
          })
          .build()
        transformer.start(MediaItem.fromUri(Uri.fromFile(inFile)), outFile.absolutePath)
      } catch (e: Throwable) {
        promise.reject("perun_video_mp4", e.message, e)
      }
    }
  }

  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
