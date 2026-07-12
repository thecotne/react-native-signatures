package expo.modules.signatures

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.ByteArrayOutputStream

class SignatureSaveOptions : Record {
  @Field val format: String = "png"
  @Field val quality: Double = 0.92
  /** ARGB int produced by React Native's processColor. */
  @Field val backgroundColor: Int? = null
  @Field val trim: Boolean = false
}

class ReactNativeSignaturesModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("ReactNativeSignatures")

    View(SignatureView::class) {
      Events("onBegin", "onEnd", "onInkChange")

      Prop("penColor") { view: SignatureView, value: Int? ->
        view.penColor = value ?: Color.BLACK
      }

      // Deliberately NOT named minWidth/maxWidth: those are reserved Yoga
      // layout prop names and would clamp the view's own size on Fabric.
      Prop("minStrokeWidth") { view: SignatureView, value: Double? ->
        view.minWidth = value ?: 0.5
      }

      Prop("maxStrokeWidth") { view: SignatureView, value: Double? ->
        view.maxWidth = value ?: 2.5
      }

      Prop("velocityFilterWeight") { view: SignatureView, value: Double? ->
        view.velocityFilterWeight = value ?: 0.7
      }

      Prop("minDistance") { view: SignatureView, value: Double? ->
        view.minDistance = value ?: 5.0
      }

      Prop("dotSize") { view: SignatureView, value: Double? ->
        view.dotSize = value ?: 0.0
      }

      AsyncFunction("clear") { view: SignatureView, promise: Promise ->
        mainHandler.post {
          view.clear()
          promise.resolve(null)
        }
      }

      AsyncFunction("isEmpty") { view: SignatureView, promise: Promise ->
        mainHandler.post {
          promise.resolve(view.isEmptySignature)
        }
      }

      AsyncFunction("save") { view: SignatureView, options: SignatureSaveOptions, promise: Promise ->
        mainHandler.post {
          val isJpeg = options.format == "jpeg"
          val background = options.backgroundColor ?: if (isJpeg) Color.WHITE else null
          val snapshot = view.renderExportBitmap(options.trim, background)
          if (snapshot == null) {
            promise.reject("ERR_SIGNATURE_SAVE", "The signature surface is not ready yet", null)
            return@post
          }
          Thread {
            try {
              val stream = ByteArrayOutputStream()
              val quality = (options.quality.coerceIn(0.0, 1.0) * 100).toInt()
              val format = if (isJpeg) Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG
              snapshot.compress(format, quality, stream)
              promise.resolve(Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP))
            } catch (e: Throwable) {
              promise.reject("ERR_SIGNATURE_SAVE", "Failed to encode the signature image", e)
            }
          }.start()
        }
      }
    }
  }
}
