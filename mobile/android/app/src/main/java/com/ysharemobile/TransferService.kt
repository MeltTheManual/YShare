package com.ysharemobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * CHUNK F (background transfers): a foreground service that keeps the app's
 * process alive during a transfer (so Android doesn't freeze the JS/WebRTC when
 * the app is backgrounded) and shows an ongoing progress notification. Driven by
 * YForegroundModule via START / UPDATE / STOP intents.
 */
class TransferService : Service() {
  companion object {
    const val CHANNEL_ID = "yshare_transfer"
    const val NOTIF_ID = 4711
    const val ACTION_START = "com.ysharemobile.TRANSFER_START"
    const val ACTION_UPDATE = "com.ysharemobile.TRANSFER_UPDATE"
    const val ACTION_STOP = "com.ysharemobile.TRANSFER_STOP"
    const val ACTION_TIMEOUT = "com.ysharemobile.TRANSFER_TIMEOUT"
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    val title = intent?.getStringExtra("title") ?: "YShare"
    val text = intent?.getStringExtra("text") ?: "Transferring…"
    val progress = intent?.getIntExtra("progress", -1) ?: -1
    ensureChannel()
    val notif = buildNotif(title, text, progress)
    if (intent?.action == ACTION_START) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIF_ID, notif)
      }
    } else {
      // UPDATE: the service is already foreground — just refresh the notification.
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.notify(NOTIF_ID, notif)
    }
    return START_NOT_STICKY
  }

  /**
   * Android 15+ gives dataSync foreground services a shared six-hour background
   * budget. The platform grants only a few seconds to stop after this callback;
   * notify JS so it can fail the transfer truthfully, then stop immediately.
   */
  override fun onTimeout(startId: Int, fgsType: Int) {
    sendBroadcast(Intent(ACTION_TIMEOUT).setPackage(packageName))
    stopForeground(STOP_FOREGROUND_REMOVE)
    stopSelf(startId)
  }

  private fun buildNotif(title: String, text: String, progress: Int): Notification {
    val b = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_sys_upload)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    when {
      progress in 0..100 -> b.setProgress(100, progress, false)
      progress < 0 -> b.setProgress(0, 0, true) // unknown → indeterminate bar
    }
    return b.build()
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        val ch = NotificationChannel(
          CHANNEL_ID, "File transfers", NotificationManager.IMPORTANCE_LOW,
        )
        ch.description = "Shows progress while a file or folder is transferring."
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
      }
    }
  }
}
