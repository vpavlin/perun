package co.logos.perun.loc

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

// Minimal type="location" foreground service — keeps the app in the "in use" state so
// the JS recorder's expo-location watchPositionAsync keeps delivering fixes with the
// screen off / phone in a pocket, WITHOUT ACCESS_BACKGROUND_LOCATION.
//
// Why bespoke instead of react-native-background-actions: that library's location-type
// startForeground NATIVE-crashes on Android 16 (API 36). Logos Delivery / qaku are
// unaffected because they use the dataSync type. This calls the modern
// startForeground(id, notification, FOREGROUND_SERVICE_TYPE_LOCATION) correctly.
class PerunLocationService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val chId = "perun_recording"
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(chId) == null) {
      nm.createNotificationChannel(
        NotificationChannel(chId, "Recording", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val notif = NotificationCompat.Builder(this, chId)
      .setContentTitle("Perun")
      .setContentText("Recording your run")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .build()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
      } else {
        startForeground(NOTIF_ID, notif)
      }
    } catch (e: Throwable) {
      // Never crash the app on a FGS-start failure — the JS recorder still works
      // foreground-only; just stop this service.
      stopSelf()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Throwable) {}
    super.onDestroy()
  }

  companion object { const val NOTIF_ID = 4711 }
}
