// Ink algorithm ported from signature_pad (https://github.com/szimek/signature_pad),
// MIT License, Copyright (c) 2023 Szymon Nowak.
// Keep the math in sync with src/signatureMath.ts — it is validated by the
// golden vectors in test-fixtures/signature-golden.json.

import ExpoModulesCore
import UIKit

struct InkSample {
  var x: CGFloat
  var y: CGFloat
  /** Milliseconds; only deltas matter. */
  var time: Double
}

class SignatureView: ExpoView {
  // MARK: - Ink parameters (set via props)

  var penColor: UIColor = .black
  var minWidth: CGFloat = 0.5
  var maxWidth: CGFloat = 2.5
  var velocityFilterWeight: CGFloat = 0.7
  var minDistance: CGFloat = 5
  var dotSize: CGFloat = 0

  // MARK: - Events

  let onBegin = EventDispatcher()
  let onEnd = EventDispatcher()
  let onInkChange = EventDispatcher()

  // MARK: - Rendering state

  private let imageView = UIImageView()
  private var buffer: CGContext?
  private var bufferSize = CGSize.zero  // in points
  private var bufferScale: CGFloat = 1

  private(set) var isEmptySignature = true
  private var inkBounds: CGRect?

  // MARK: - Stroke state (signature_pad `_reset` / `_lastPoints`)

  private var sampleWindow: [InkSample] = []
  private var lastVelocity: CGFloat = 0
  private var lastWidth: CGFloat = 1.5
  private var isStroking = false

  private struct CurveSegment {
    var startPoint: InkSample
    var control1: CGPoint
    var control2: CGPoint
    var endPoint: InkSample
    var startWidth: CGFloat
    var endWidth: CGFloat
  }

  /**
   * Begins immediately on touch-down (before any movement), so an ancestor
   * UIScrollView's pan recognizer — which needs ~10pt of movement — can never
   * start and steal the stroke mid-draw. `cancelsTouchesInView = false` keeps
   * the raw touches (incl. coalesced samples) flowing to `touchesMoved`.
   */
  private let strokeGuard = UILongPressGestureRecognizer()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isMultipleTouchEnabled = false
    imageView.contentMode = .topLeft
    imageView.isUserInteractionEnabled = false
    addSubview(imageView)

    strokeGuard.minimumPressDuration = 0
    strokeGuard.allowableMovement = .greatestFiniteMagnitude
    strokeGuard.cancelsTouchesInView = false
    strokeGuard.delaysTouchesBegan = false
    strokeGuard.delaysTouchesEnded = false
    addGestureRecognizer(strokeGuard)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = bounds
    ensureBuffer()
  }

  // MARK: - Backing buffer

  private func ensureBuffer() {
    let size = bounds.size
    guard size.width >= 1, size.height >= 1 else {
      return
    }
    let scale = max(traitCollection.displayScale, 1)
    if buffer != nil && size == bufferSize && scale == bufferScale {
      return
    }

    let widthPx = max(Int((size.width * scale).rounded()), 1)
    let heightPx = max(Int((size.height * scale).rounded()), 1)
    guard let context = CGContext(
      data: nil,
      width: widthPx,
      height: heightPx,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else {
      return
    }
    // Flip into UIKit-style coordinates (origin top-left) and draw in points.
    context.translateBy(x: 0, y: CGFloat(heightPx))
    context.scaleBy(x: scale, y: -scale)
    context.setShouldAntialias(true)

    // Preserve existing ink across resizes, anchored top-left, unscaled.
    if let oldImage = buffer?.makeImage() {
      let oldPointSize = CGSize(
        width: CGFloat(oldImage.width) / bufferScale,
        height: CGFloat(oldImage.height) / bufferScale
      )
      context.saveGState()
      context.translateBy(x: 0, y: oldPointSize.height)
      context.scaleBy(x: 1, y: -1)
      context.draw(oldImage, in: CGRect(origin: .zero, size: oldPointSize))
      context.restoreGState()
    }

    buffer = context
    bufferSize = size
    bufferScale = scale
    refreshDisplay()
  }

  private func refreshDisplay() {
    guard let cgImage = buffer?.makeImage() else {
      imageView.image = nil
      return
    }
    imageView.image = UIImage(cgImage: cgImage, scale: bufferScale, orientation: .up)
  }

  // MARK: - Touch handling

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let touch = touches.first else {
      return
    }
    ensureBuffer()
    isStroking = true
    beginStroke()
    onBegin([:])
    process(touch: touch, event: event)
    refreshDisplay()
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard isStroking, let touch = touches.first else {
      return
    }
    process(touch: touch, event: event)
    refreshDisplay()
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard isStroking, let touch = touches.first else {
      return
    }
    process(touch: touch, event: event)
    endStrokeSession()
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard isStroking else {
      return
    }
    endStrokeSession()
  }

  private func process(touch: UITouch, event: UIEvent?) {
    let samples = event?.coalescedTouches(for: touch) ?? [touch]
    for sample in samples {
      let location = sample.location(in: self)
      addSample(InkSample(x: location.x, y: location.y, time: sample.timestamp * 1000))
    }
  }

  private func endStrokeSession() {
    isStroking = false
    refreshDisplay()
    onEnd([:])
    onInkChange(["isEmpty": isEmptySignature])
  }

  // MARK: - signature_pad algorithm

  private func beginStroke() {
    sampleWindow.removeAll(keepingCapacity: true)
    lastVelocity = 0
    lastWidth = (minWidth + maxWidth) / 2
  }

  private func addSample(_ point: InkSample) {
    let last = sampleWindow.last
    if let last, distance(from: last, to: point) <= minDistance {
      return
    }
    let curve = pushToWindow(point)
    if last == nil {
      drawDot(x: point.x, y: point.y, radius: dotRadius())
    } else if let curve {
      drawCurve(curve)
    }
  }

  private func pushToWindow(_ point: InkSample) -> CurveSegment? {
    sampleWindow.append(point)
    if sampleWindow.count > 2 {
      // The first curve reuses the first point as its leading neighbor.
      if sampleWindow.count == 3 {
        sampleWindow.insert(sampleWindow[0], at: 0)
      }
      let widths = calculateCurveWidths(start: sampleWindow[1], end: sampleWindow[2])
      let curve = bezierFromWindow(widths: widths)
      sampleWindow.removeFirst()
      return curve
    }
    return nil
  }

  private func calculateCurveWidths(start: InkSample, end: InkSample) -> (start: CGFloat, end: CGFloat) {
    let velocity = velocityFilterWeight * velocity(from: start, to: end)
      + (1 - velocityFilterWeight) * lastVelocity
    let newWidth = max(maxWidth / (velocity + 1), minWidth)
    let widths = (start: lastWidth, end: newWidth)
    lastVelocity = velocity
    lastWidth = newWidth
    return widths
  }

  private func distance(from a: InkSample, to b: InkSample) -> CGFloat {
    let dx = a.x - b.x
    let dy = a.y - b.y
    return sqrt(dx * dx + dy * dy)
  }

  private func velocity(from start: InkSample, to end: InkSample) -> CGFloat {
    return end.time != start.time
      ? distance(from: start, to: end) / CGFloat(end.time - start.time)
      : 0
  }

  private func dotRadius() -> CGFloat {
    return dotSize > 0 ? dotSize : (minWidth + maxWidth) / 2
  }

  private func controlPoints(_ s1: InkSample, _ s2: InkSample, _ s3: InkSample) -> (c1: CGPoint, c2: CGPoint) {
    let dx1 = s1.x - s2.x
    let dy1 = s1.y - s2.y
    let dx2 = s2.x - s3.x
    let dy2 = s2.y - s3.y

    let m1 = CGPoint(x: (s1.x + s2.x) / 2.0, y: (s1.y + s2.y) / 2.0)
    let m2 = CGPoint(x: (s2.x + s3.x) / 2.0, y: (s2.y + s3.y) / 2.0)

    let l1 = sqrt(dx1 * dx1 + dy1 * dy1)
    let l2 = sqrt(dx2 * dx2 + dy2 * dy2)

    let dxm = m1.x - m2.x
    let dym = m1.y - m2.y

    let k: CGFloat = (l1 + l2) == 0 ? 0 : l2 / (l1 + l2)
    let cm = CGPoint(x: m2.x + dxm * k, y: m2.y + dym * k)

    let tx = s2.x - cm.x
    let ty = s2.y - cm.y

    return (
      c1: CGPoint(x: m1.x + tx, y: m1.y + ty),
      c2: CGPoint(x: m2.x + tx, y: m2.y + ty)
    )
  }

  private func bezierFromWindow(widths: (start: CGFloat, end: CGFloat)) -> CurveSegment {
    let c2 = controlPoints(sampleWindow[0], sampleWindow[1], sampleWindow[2]).c2
    let c3 = controlPoints(sampleWindow[1], sampleWindow[2], sampleWindow[3]).c1
    return CurveSegment(
      startPoint: sampleWindow[1],
      control1: c2,
      control2: c3,
      endPoint: sampleWindow[2],
      startWidth: widths.start,
      endWidth: widths.end
    )
  }

  private func bezierPoint(_ t: CGFloat, _ start: CGFloat, _ c1: CGFloat, _ c2: CGFloat, _ end: CGFloat) -> CGFloat {
    return start * (1.0 - t) * (1.0 - t) * (1.0 - t)
      + 3.0 * c1 * (1.0 - t) * (1.0 - t) * t
      + 3.0 * c2 * (1.0 - t) * t * t
      + end * t * t * t
  }

  private func bezierLength(_ curve: CurveSegment) -> CGFloat {
    let steps = 10
    var length: CGFloat = 0
    var px: CGFloat = 0
    var py: CGFloat = 0
    for i in 0...steps {
      let t = CGFloat(i) / CGFloat(steps)
      let cx = bezierPoint(t, curve.startPoint.x, curve.control1.x, curve.control2.x, curve.endPoint.x)
      let cy = bezierPoint(t, curve.startPoint.y, curve.control1.y, curve.control2.y, curve.endPoint.y)
      if i > 0 {
        let xdiff = cx - px
        let ydiff = cy - py
        length += sqrt(xdiff * xdiff + ydiff * ydiff)
      }
      px = cx
      py = cy
    }
    return length
  }

  // MARK: - Incremental drawing

  private func drawCurve(_ curve: CurveSegment) {
    guard let context = buffer else {
      return
    }
    let widthDelta = curve.endWidth - curve.startWidth
    let drawSteps = Int(ceil(bezierLength(curve))) * 2
    guard drawSteps > 0 else {
      return
    }

    let path = CGMutablePath()
    for i in 0..<drawSteps {
      let t = CGFloat(i) / CGFloat(drawSteps)
      let tt = t * t
      let ttt = tt * t
      let u = 1 - t
      let uu = u * u
      let uuu = uu * u

      var x = uuu * curve.startPoint.x
      x += 3 * uu * t * curve.control1.x
      x += 3 * u * tt * curve.control2.x
      x += ttt * curve.endPoint.x

      var y = uuu * curve.startPoint.y
      y += 3 * uu * t * curve.control1.y
      y += 3 * u * tt * curve.control2.y
      y += ttt * curve.endPoint.y

      let width = min(curve.startWidth + ttt * widthDelta, maxWidth)
      path.addEllipse(in: CGRect(x: x - width, y: y - width, width: width * 2, height: width * 2))
      trackBounds(x: x, y: y, radius: width)
    }

    context.setFillColor(penColor.cgColor)
    context.addPath(path)
    context.fillPath()
    markNotEmpty()
  }

  private func drawDot(x: CGFloat, y: CGFloat, radius: CGFloat) {
    guard let context = buffer else {
      return
    }
    let path = CGMutablePath()
    path.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
    context.setFillColor(penColor.cgColor)
    context.addPath(path)
    context.fillPath()
    trackBounds(x: x, y: y, radius: radius)
    markNotEmpty()
  }

  private func trackBounds(x: CGFloat, y: CGFloat, radius: CGFloat) {
    let rect = CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2)
    inkBounds = inkBounds?.union(rect) ?? rect
  }

  private func markNotEmpty() {
    if isEmptySignature {
      isEmptySignature = false
      onInkChange(["isEmpty": false])
    }
  }

  // MARK: - Commands (invoked from the module on the main thread)

  func clear() {
    sampleWindow.removeAll()
    isStroking = false
    inkBounds = nil
    buffer?.clear(CGRect(origin: .zero, size: bufferSize))
    refreshDisplay()
    if !isEmptySignature {
      isEmptySignature = true
      onInkChange(["isEmpty": true])
    }
  }

  /**
   * Snapshot the ink as a CGImage, optionally trimmed to the ink bounds and
   * composited over a background color. Returns nil when the drawing surface
   * has not been laid out yet.
   */
  func renderExportImage(trim: Bool, backgroundColor: UIColor?) -> CGImage? {
    guard var image = buffer?.makeImage() else {
      return nil
    }

    if trim, let bounds = inkBounds {
      let clamped = bounds.intersection(CGRect(origin: .zero, size: bufferSize))
      if !clamped.isEmpty {
        let pixelRect = CGRect(
          x: clamped.minX * bufferScale,
          y: clamped.minY * bufferScale,
          width: clamped.width * bufferScale,
          height: clamped.height * bufferScale
        ).integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        if !pixelRect.isEmpty, let cropped = image.cropping(to: pixelRect) {
          image = cropped
        }
      }
    }

    guard let background = backgroundColor else {
      return image
    }
    guard let context = CGContext(
      data: nil,
      width: image.width,
      height: image.height,
      bitsPerComponent: 8,
      bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
    ) else {
      return image
    }
    let rect = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    context.setFillColor(background.cgColor)
    context.fill(rect)
    context.draw(image, in: rect)
    return context.makeImage() ?? image
  }
}
