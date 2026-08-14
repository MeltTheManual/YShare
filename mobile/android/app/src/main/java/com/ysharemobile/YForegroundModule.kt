package com.ysharemobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * CHUNK F: JS handle to the transfer foreground service. start() must be called
 * while the app is in the foreground (a transfer always begins there); update()
 * and stop() just refresh/tear down the already-running service.
 */
class YForegroundModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  private val timeoutReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == TransferService.ACTION_TIMEOUT && ctx.hasActiveReactInstance()) {
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
          .emit("yshareForegroundTimeout", null)
      }
    }
  }

  init {
    ContextCompat.registerReceiver(
      ctx,
      timeoutReceiver,
      IntentFilter(TransferService.ACTION_TIMEOUT),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  override fun getName() = "YForeground"

  private fun svc(action: String, title: String, text: String, progress: Int): Intent =
    Intent(ctx, TransferService::class.java).apply {
      this.action = action
      putExtra("title", title)
      putExtra("text", text)
      putExtra("progress", progress)
    }

  @ReactMethod
  fun start(title: String, text: String, promise: Promise) {
    try {
      val i = svc(TransferService.ACTION_START, title, text, -1)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
      else ctx.startService(i)
      promise.resolve(null)
    } catch (e: Exception) {
      promise.reject("EFGS", e.message ?: "could not start the transfer service", e)
    }
  }

  @ReactMethod
  fun update(title: String, text: String, progress: Double) {
    try { ctx.startService(svc(TransferService.ACTION_UPDATE, title, text, progress.toInt())) }
    catch (e: Exception) { /* best-effort UI update */ }
  }

  @ReactMethod
  fun stop() {
    try { ctx.startService(svc(TransferService.ACTION_STOP, "YShare", "", -1)) }
    catch (e: Exception) { /* already stopped */ }
  }

  // Required by NativeEventEmitter; the receiver itself owns the native event source.
  @ReactMethod
  fun addListener(eventName: String) = Unit

  @ReactMethod
  fun removeListeners(count: Double) = Unit

  override fun invalidate() {
    try { ctx.unregisterReceiver(timeoutReceiver) } catch (_: Exception) {}
    super.invalidate()
  }
}
