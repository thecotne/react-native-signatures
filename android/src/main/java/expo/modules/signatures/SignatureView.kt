// Ink algorithm ported from signature_pad (https://github.com/szimek/signature_pad),
// MIT License, Copyright (c) 2023 Szymon Nowak.
// Keep the math in sync with src/signatureMath.ts — it is validated by the
// golden vectors in test-fixtures/signature-golden.json.

package expo.modules.signatures

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.view.MotionEvent
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** One touch sample in dp coordinates; time in milliseconds. */
data class InkSample(val x: Double, val y: Double, val time: Double)

class SignatureView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  // Ink parameters (set via props). Widths and distances are in dp so the
  // geometry matches iOS points and web CSS pixels.
  var penColor: Int = Color.BLACK
  var minWidth: Double = 0.5
  var maxWidth: Double = 2.5
  var velocityFilterWeight: Double = 0.7
  var minDistance: Double = 5.0
  var dotSize: Double = 0.0

  private val onBegin by EventDispatcher<Unit>()
  private val onEnd by EventDispatcher<Unit>()
  private val onInkChange by EventDispatcher<Map<String, Any>>()

  // Backing buffer: a px-sized bitmap drawn through a density-scaled canvas,
  // so all ink geometry stays in dp.
  private var bitmap: Bitmap? = null
  private var bufferCanvas: Canvas? = null
  private val density: Float = context.resources.displayMetrics.density

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val fillPath = Path()

  var isEmptySignature = true
    private set
  private var inkBounds: RectF? = null // dp coordinates

  // Stroke state (signature_pad `_reset` / `_lastPoints`)
  private val sampleWindow = ArrayList<InkSample>(5)
  private var lastVelocity = 0.0
  private var lastWidth = 1.5
  private var isStroking = false

  private class CurveSegment(
    val startPoint: InkSample,
    val c1x: Double,
    val c1y: Double,
    val c2x: Double,
    val c2y: Double,
    val endPoint: InkSample,
    val startWidth: Double,
    val endWidth: Double,
  )

  init {
    setWillNotDraw(false)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w <= 0 || h <= 0) {
      return
    }
    val old = bitmap
    val next = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(next)
    // Preserve existing ink across resizes, anchored top-left, unscaled.
    if (old != null) {
      canvas.drawBitmap(old, 0f, 0f, null)
    }
    canvas.scale(density, density)
    bitmap = next
    bufferCanvas = canvas
    old?.recycle()
    invalidate()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    bitmap?.let { canvas.drawBitmap(it, 0f, 0f, null) }
  }

  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        parent?.requestDisallowInterceptTouchEvent(true)
        isStroking = true
        beginStroke()
        onBegin(Unit)
        processMotion(event)
        invalidate()
      }
      MotionEvent.ACTION_MOVE -> {
        if (!isStroking) {
          return false
        }
        processMotion(event)
        invalidate()
      }
      MotionEvent.ACTION_UP -> {
        if (!isStroking) {
          return false
        }
        processMotion(event)
        endStrokeSession()
      }
      MotionEvent.ACTION_CANCEL -> {
        if (!isStroking) {
          return false
        }
        endStrokeSession()
      }
      else -> return false
    }
    return true
  }

  private fun processMotion(event: MotionEvent) {
    for (i in 0 until event.historySize) {
      addSample(
        InkSample(
          (event.getHistoricalX(i) / density).toDouble(),
          (event.getHistoricalY(i) / density).toDouble(),
          event.getHistoricalEventTime(i).toDouble(),
        ),
      )
    }
    addSample(
      InkSample(
        (event.x / density).toDouble(),
        (event.y / density).toDouble(),
        event.eventTime.toDouble(),
      ),
    )
  }

  private fun endStrokeSession() {
    isStroking = false
    invalidate()
    onEnd(Unit)
    onInkChange(mapOf("isEmpty" to isEmptySignature))
  }

  // MARK: signature_pad algorithm

  private fun beginStroke() {
    sampleWindow.clear()
    lastVelocity = 0.0
    lastWidth = (minWidth + maxWidth) / 2
  }

  private fun addSample(point: InkSample) {
    val last = sampleWindow.lastOrNull()
    if (last != null && distance(last, point) <= minDistance) {
      return
    }
    val curve = pushToWindow(point)
    if (last == null) {
      drawDot(point.x, point.y, dotRadius())
    } else if (curve != null) {
      drawCurve(curve)
    }
  }

  private fun pushToWindow(point: InkSample): CurveSegment? {
    sampleWindow.add(point)
    if (sampleWindow.size > 2) {
      // The first curve reuses the first point as its leading neighbor.
      if (sampleWindow.size == 3) {
        sampleWindow.add(0, sampleWindow[0])
      }
      val widths = calculateCurveWidths(sampleWindow[1], sampleWindow[2])
      val cp1 = controlPoints(sampleWindow[0], sampleWindow[1], sampleWindow[2])
      val cp2 = controlPoints(sampleWindow[1], sampleWindow[2], sampleWindow[3])
      val curve = CurveSegment(
        startPoint = sampleWindow[1],
        c1x = cp1[2],
        c1y = cp1[3],
        c2x = cp2[0],
        c2y = cp2[1],
        endPoint = sampleWindow[2],
        startWidth = widths.first,
        endWidth = widths.second,
      )
      sampleWindow.removeAt(0)
      return curve
    }
    return null
  }

  private fun calculateCurveWidths(start: InkSample, end: InkSample): Pair<Double, Double> {
    val velocity = velocityFilterWeight * velocityFrom(start, end) +
      (1 - velocityFilterWeight) * lastVelocity
    val newWidth = max(maxWidth / (velocity + 1), minWidth)
    val widths = Pair(lastWidth, newWidth)
    lastVelocity = velocity
    lastWidth = newWidth
    return widths
  }

  private fun distance(a: InkSample, b: InkSample): Double {
    val dx = a.x - b.x
    val dy = a.y - b.y
    return sqrt(dx * dx + dy * dy)
  }

  private fun velocityFrom(start: InkSample, end: InkSample): Double {
    return if (end.time != start.time) distance(start, end) / (end.time - start.time) else 0.0
  }

  private fun dotRadius(): Double {
    return if (dotSize > 0) dotSize else (minWidth + maxWidth) / 2
  }

  /** Returns [c1x, c1y, c2x, c2y]. */
  private fun controlPoints(s1: InkSample, s2: InkSample, s3: InkSample): DoubleArray {
    val dx1 = s1.x - s2.x
    val dy1 = s1.y - s2.y
    val dx2 = s2.x - s3.x
    val dy2 = s2.y - s3.y

    val m1x = (s1.x + s2.x) / 2.0
    val m1y = (s1.y + s2.y) / 2.0
    val m2x = (s2.x + s3.x) / 2.0
    val m2y = (s2.y + s3.y) / 2.0

    val l1 = sqrt(dx1 * dx1 + dy1 * dy1)
    val l2 = sqrt(dx2 * dx2 + dy2 * dy2)

    val dxm = m1x - m2x
    val dym = m1y - m2y

    val k = if (l1 + l2 == 0.0) 0.0 else l2 / (l1 + l2)
    val cmx = m2x + dxm * k
    val cmy = m2y + dym * k

    val tx = s2.x - cmx
    val ty = s2.y - cmy

    return doubleArrayOf(m1x + tx, m1y + ty, m2x + tx, m2y + ty)
  }

  private fun bezierPoint(t: Double, start: Double, c1: Double, c2: Double, end: Double): Double {
    return start * (1.0 - t) * (1.0 - t) * (1.0 - t) +
      3.0 * c1 * (1.0 - t) * (1.0 - t) * t +
      3.0 * c2 * (1.0 - t) * t * t +
      end * t * t * t
  }

  private fun bezierLength(curve: CurveSegment): Double {
    val steps = 10
    var length = 0.0
    var px = 0.0
    var py = 0.0
    for (i in 0..steps) {
      val t = i.toDouble() / steps
      val cx = bezierPoint(t, curve.startPoint.x, curve.c1x, curve.c2x, curve.endPoint.x)
      val cy = bezierPoint(t, curve.startPoint.y, curve.c1y, curve.c2y, curve.endPoint.y)
      if (i > 0) {
        val xdiff = cx - px
        val ydiff = cy - py
        length += sqrt(xdiff * xdiff + ydiff * ydiff)
      }
      px = cx
      py = cy
    }
    return length
  }

  // MARK: Incremental drawing

  private fun drawCurve(curve: CurveSegment) {
    val canvas = bufferCanvas ?: return
    val widthDelta = curve.endWidth - curve.startWidth
    val drawSteps = ceil(bezierLength(curve)).toInt() * 2
    if (drawSteps <= 0) {
      return
    }

    fillPath.rewind()
    for (i in 0 until drawSteps) {
      val t = i.toDouble() / drawSteps
      val tt = t * t
      val ttt = tt * t
      val u = 1 - t
      val uu = u * u
      val uuu = uu * u

      var x = uuu * curve.startPoint.x
      x += 3 * uu * t * curve.c1x
      x += 3 * u * tt * curve.c2x
      x += ttt * curve.endPoint.x

      var y = uuu * curve.startPoint.y
      y += 3 * uu * t * curve.c1y
      y += 3 * u * tt * curve.c2y
      y += ttt * curve.endPoint.y

      val width = min(curve.startWidth + ttt * widthDelta, maxWidth)
      fillPath.addCircle(x.toFloat(), y.toFloat(), width.toFloat(), Path.Direction.CW)
      trackBounds(x, y, width)
    }

    paint.color = penColor
    canvas.drawPath(fillPath, paint)
    markNotEmpty()
  }

  private fun drawDot(x: Double, y: Double, radius: Double) {
    val canvas = bufferCanvas ?: return
    fillPath.rewind()
    fillPath.addCircle(x.toFloat(), y.toFloat(), radius.toFloat(), Path.Direction.CW)
    paint.color = penColor
    canvas.drawPath(fillPath, paint)
    trackBounds(x, y, radius)
    markNotEmpty()
  }

  private fun trackBounds(x: Double, y: Double, radius: Double) {
    val left = (x - radius).toFloat()
    val top = (y - radius).toFloat()
    val right = (x + radius).toFloat()
    val bottom = (y + radius).toFloat()
    val bounds = inkBounds
    if (bounds == null) {
      inkBounds = RectF(left, top, right, bottom)
    } else {
      bounds.union(left, top, right, bottom)
    }
  }

  private fun markNotEmpty() {
    if (isEmptySignature) {
      isEmptySignature = false
      onInkChange(mapOf("isEmpty" to false))
    }
  }

  // MARK: Commands (invoked from the module on the main thread)

  fun clear() {
    sampleWindow.clear()
    isStroking = false
    inkBounds = null
    bitmap?.eraseColor(Color.TRANSPARENT)
    invalidate()
    if (!isEmptySignature) {
      isEmptySignature = true
      onInkChange(mapOf("isEmpty" to true))
    }
  }

  /**
   * Snapshot the ink into a new bitmap, optionally trimmed to the ink bounds
   * and composited over a background color. Returns null when the drawing
   * surface has not been laid out yet.
   */
  fun renderExportBitmap(trim: Boolean, backgroundColor: Int?): Bitmap? {
    val source = bitmap ?: return null
    var srcRect = Rect(0, 0, source.width, source.height)
    if (trim) {
      inkBounds?.let { bounds ->
        val left = max(floor(bounds.left * density).toInt(), 0)
        val top = max(floor(bounds.top * density).toInt(), 0)
        val right = min(ceil(bounds.right * density).toInt(), source.width)
        val bottom = min(ceil(bounds.bottom * density).toInt(), source.height)
        if (right - left >= 1 && bottom - top >= 1) {
          srcRect = Rect(left, top, right, bottom)
        }
      }
    }
    val output = Bitmap.createBitmap(srcRect.width(), srcRect.height(), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    if (backgroundColor != null) {
      canvas.drawColor(backgroundColor)
    }
    canvas.drawBitmap(source, srcRect, Rect(0, 0, srcRect.width(), srcRect.height()), null)
    return output
  }
}
