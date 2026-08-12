package co.logos.perun.loc

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

// JS bridge for the location foreground service. start()/stop() from keepalive.ts.
class PerunLocationModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {
  override fun getName() = "PerunLocation"

  @ReactMethod
  fun start(promise: Promise) {
    try {
      val i = Intent(ctx, PerunLocationService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i) else ctx.startService(i)
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("perun_loc_start", e.message, e)
    }
  }

  @ReactMethod
  fun stop(promise: Promise) {
    try {
      ctx.stopService(Intent(ctx, PerunLocationService::class.java))
      promise.resolve(true)
    } catch (e: Throwable) {
      promise.reject("perun_loc_stop", e.message, e)
    }
  }

  // RN event-emitter contract (harmless no-ops; keeps the module happy).
  @ReactMethod fun addListener(eventName: String) {}
  @ReactMethod fun removeListeners(count: Int) {}
}
