package com.ysharemobile

import android.net.Uri
import android.util.Base64
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import kotlin.math.floor

/**
 * YRawFile — positioned raw file writes for the transfer engine.
 * Receives base64 chunks (as delivered by react-native-webrtc's bridge events),
 * decodes them NATIVELY and writes them at their absolute offset in the final
 * file. Replaces the old per-connection part-files + stitch step entirely, and
 * removes all base64 encode/decode work from the JS thread.
 *
 * All I/O runs on one dedicated thread: calls execute strictly in arrival
 * order, off both the JS thread and the native-modules queue.
 */
class YRawFileModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  private val files = HashMap<Int, RandomAccessFile>() // touched only on the io thread
  private val paths = HashMap<Int, File>()
  private val sizes = HashMap<Int, Long>()
  private var nextId = 1
  private val io = Executors.newSingleThreadExecutor()

  companion object {
    private const val MAX_TRANSFER_BYTES = 8L * 1024L * 1024L * 1024L * 1024L
    private const val MAX_CHUNK_BYTES = 64 * 1024
    private const val MAX_BATCH_PARTS = 64
  }

  override fun getName() = "YRawFile"

  private fun checkedWholeNumber(value: Double, label: String, max: Long): Long {
    if (!value.isFinite() || value < 0.0 || value > max.toDouble() || floor(value) != value) {
      throw IllegalArgumentException("$label is out of range")
    }
    return value.toLong()
  }

  /** Every receive temp must stay under this app's private files directory. */
  private fun checkedPrivateFile(path: String): File {
    val base = reactApplicationContext.filesDir.canonicalFile
    val file = File(path).canonicalFile
    val prefix = base.path + File.separator
    if (file.path != base.path && !file.path.startsWith(prefix)) {
      throw SecurityException("write path escaped app-private storage")
    }
    if (file == base) throw SecurityException("write path must be a file")
    return file
  }

  private fun checkedHandle(value: Double): Int {
    val id = checkedWholeNumber(value, "file handle", Int.MAX_VALUE.toLong()).toInt()
    if (id == 0) throw IllegalArgumentException("bad file handle")
    return id
  }

  private fun closeAndDelete(id: Int) {
    try { files.remove(id)?.close() } finally {
      sizes.remove(id)
      paths.remove(id)?.delete()
    }
  }

  /** Create/truncate the file and preallocate it to its final size. Resolves to a handle id. */
  @ReactMethod
  fun openWrite(path: String, size: Double, promise: Promise) {
    io.execute {
      try {
        val finalSize = checkedWholeNumber(size, "file size", MAX_TRANSFER_BYTES)
        val f = checkedPrivateFile(path)
        f.parentFile?.mkdirs()
        if (f.exists() && (!f.isFile || !f.delete())) {
          throw IllegalStateException("could not replace private temp file")
        }
        val raf = RandomAccessFile(f, "rw")
        raf.setLength(finalSize)
        val id = nextId++
        files[id] = raf
        paths[id] = f
        sizes[id] = finalSize
        promise.resolve(id)
      } catch (e: Exception) {
        promise.reject("EOPEN", e.message ?: "open failed", e)
      }
    }
  }

  /**
   * Decode each base64 part and write them back-to-back starting at `offset`.
   * Parts are one batch from ONE connection's contiguous range, so a running
   * position is correct. Resolves to the number of bytes written.
   */
  @ReactMethod
  fun writeBatch(id: Double, offset: Double, parts: ReadableArray, promise: Promise) {
    io.execute {
      try {
        val handle = checkedHandle(id)
        val raf = files[handle] ?: throw IllegalStateException("bad file handle")
        val expectedSize = sizes[handle] ?: throw IllegalStateException("missing file size")
        if (parts.size() <= 0 || parts.size() > MAX_BATCH_PARTS) {
          throw IllegalArgumentException("invalid write batch")
        }
        val start = checkedWholeNumber(offset, "write offset", expectedSize)
        var pos = start
        for (i in 0 until parts.size()) {
          val b64 = parts.getString(i) ?: throw IllegalStateException("null part")
          if (b64.length > ((MAX_CHUNK_BYTES + 2) / 3) * 4) {
            throw IllegalArgumentException("chunk is too large")
          }
          val bytes = Base64.decode(b64, Base64.NO_WRAP)
          if (bytes.isEmpty() || bytes.size > MAX_CHUNK_BYTES || pos > expectedSize - bytes.size) {
            throw IllegalArgumentException("write exceeds accepted file range")
          }
          raf.seek(pos)
          raf.write(bytes)
          pos += bytes.size
        }
        promise.resolve((pos - start).toDouble())
      } catch (e: Exception) {
        promise.reject("EWRITE", e.message ?: "write failed", e)
      }
    }
  }

  @ReactMethod
  fun closeWrite(id: Double, promise: Promise) {
    io.execute {
      try {
        val handle = checkedHandle(id)
        val raf = files.remove(handle) ?: throw IllegalStateException("bad file handle")
        raf.fd.sync()
        raf.close()
        paths.remove(handle)
        sizes.remove(handle)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("ECLOSE", e.message ?: "close failed", e)
      }
    }
  }

  /** Close AND delete — cleanup after a failed/aborted transfer. */
  @ReactMethod
  fun abortWrite(id: Double, promise: Promise) {
    io.execute {
      try {
        closeAndDelete(checkedHandle(id))
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("EABORT", e.message ?: "abort failed", e)
      }
    }
  }

  /** Emergency/reset cleanup: close and delete every private receive temp. */
  @ReactMethod
  fun abortAll(promise: Promise) {
    io.execute {
      try {
        files.keys.toList().forEach(::closeAndDelete)
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("EABORTALL", e.message ?: "cleanup failed", e)
      }
    }
  }

  /**
   * Folder SEND (CHUNK F): recursively copy a picked SAF directory tree into app
   * cache. Content:// tree children can't be positioned-read, so we materialise
   * real seekable files the existing chunk-reader can stream. Returns
   * { name, files:[{ relPath, path, size }] } — the sender's folder manifest.
   */
  @ReactMethod
  fun copyTreeToCache(treeUri: String, promise: Promise) {
    io.execute {
      val destBase = File(reactApplicationContext.cacheDir, "yshare_send")
      try {
        val ctx = reactApplicationContext
        val root = DocumentFile.fromTreeUri(ctx, Uri.parse(treeUri))
          ?: throw IllegalStateException("could not open the selected folder")
        val rootName = (root.name ?: "folder")
          .replace(Regex("[\\u0000-\\u001f<>:\"/\\\\|?*]"), "_")
          .trim().ifEmpty { "folder" }.take(240)
        if (destBase.exists()) destBase.deleteRecursively()
        if (!destBase.mkdirs() && !destBase.isDirectory) {
          throw IllegalStateException("could not create sender cache")
        }
        val destRoot = destBase.canonicalFile

        val out = Arguments.createArray()
        // Iterative depth-first walk (no recursion depth limit on huge trees).
        val stack = ArrayDeque<Pair<DocumentFile, String>>()
        stack.addLast(root to "")
        while (stack.isNotEmpty()) {
          val (doc, rel) = stack.removeLast()
          for (child in doc.listFiles()) {
            val name = child.name ?: continue
            val childRel = if (rel.isEmpty()) name else "$rel/$name"
            if (child.isDirectory) {
              stack.addLast(child to childRel)
            } else if (child.isFile) {
              val destFile = File(destBase, childRel).canonicalFile
              if (!destFile.path.startsWith(destRoot.path + File.separator)) {
                throw SecurityException("selected folder contains an unsafe path")
              }
              destFile.parentFile?.mkdirs()
              val input = ctx.contentResolver.openInputStream(child.uri)
                ?: throw IllegalStateException("could not read $childRel")
              input.use { inp -> destFile.outputStream().use { outp -> inp.copyTo(outp) } }
              val m = Arguments.createMap()
              m.putString("relPath", childRel)
              m.putString("path", destFile.absolutePath)
              m.putDouble("size", destFile.length().toDouble())
              out.pushMap(m)
            }
          }
        }
        val res = Arguments.createMap()
        res.putString("name", rootName)
        res.putArray("files", out)
        promise.resolve(res)
      } catch (e: Exception) {
        // A failed SAF read must never leave a half-copied folder available to a
        // later transfer. The JS manifest is deliberately not resolved on error.
        try { if (destBase.exists()) destBase.deleteRecursively() } catch (_: Exception) {}
        promise.reject("ECOPYTREE", e.message ?: "folder copy failed", e)
      }
    }
  }


  override fun invalidate() {
    io.execute {
      files.keys.toList().forEach {
        try { closeAndDelete(it) } catch (_: Exception) {}
      }
    }
    super.invalidate()
  }
}
