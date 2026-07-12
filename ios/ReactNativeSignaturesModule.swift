import ExpoModulesCore
import UIKit

struct SignatureSaveOptions: Record {
  @Field var format: String = "png"
  @Field var quality: Double = 0.92
  /** ARGB int produced by React Native's processColor. */
  @Field var backgroundColor: Int?
  @Field var trim: Bool = false
}

private func color(fromARGB value: Int?) -> UIColor? {
  guard let value else {
    return nil
  }
  let argb = UInt32(truncatingIfNeeded: value)
  return UIColor(
    red: CGFloat((argb >> 16) & 0xFF) / 255.0,
    green: CGFloat((argb >> 8) & 0xFF) / 255.0,
    blue: CGFloat(argb & 0xFF) / 255.0,
    alpha: CGFloat((argb >> 24) & 0xFF) / 255.0
  )
}

public class ReactNativeSignaturesModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ReactNativeSignatures")

    View(SignatureView.self) {
      Events("onBegin", "onEnd", "onInkChange")

      Prop("penColor") { (view: SignatureView, value: Int?) in
        view.penColor = color(fromARGB: value) ?? .black
      }

      Prop("minStrokeWidth") { (view: SignatureView, value: Double?) in
        view.minWidth = CGFloat(value ?? 0.5)
      }

      Prop("maxStrokeWidth") { (view: SignatureView, value: Double?) in
        view.maxWidth = CGFloat(value ?? 2.5)
      }

      Prop("velocityFilterWeight") { (view: SignatureView, value: Double?) in
        view.velocityFilterWeight = CGFloat(value ?? 0.7)
      }

      Prop("minDistance") { (view: SignatureView, value: Double?) in
        view.minDistance = CGFloat(value ?? 5)
      }

      Prop("dotSize") { (view: SignatureView, value: Double?) in
        view.dotSize = CGFloat(value ?? 0)
      }

      AsyncFunction("clear") { (view: SignatureView, promise: Promise) in
        DispatchQueue.main.async {
          view.clear()
          promise.resolve()
        }
      }

      AsyncFunction("isEmpty") { (view: SignatureView, promise: Promise) in
        DispatchQueue.main.async {
          promise.resolve(view.isEmptySignature)
        }
      }

      AsyncFunction("save") { (view: SignatureView, options: SignatureSaveOptions, promise: Promise) in
        DispatchQueue.main.async {
          let isJpeg = options.format == "jpeg"
          let background = color(fromARGB: options.backgroundColor) ?? (isJpeg ? UIColor.white : nil)
          guard let image = view.renderExportImage(trim: options.trim, backgroundColor: background) else {
            promise.reject("ERR_SIGNATURE_SAVE", "The signature surface is not ready yet")
            return
          }
          let quality = min(max(options.quality, 0), 1)
          DispatchQueue.global(qos: .userInitiated).async {
            let uiImage = UIImage(cgImage: image)
            let data = isJpeg ? uiImage.jpegData(compressionQuality: quality) : uiImage.pngData()
            if let data {
              promise.resolve(data.base64EncodedString())
            } else {
              promise.reject("ERR_SIGNATURE_SAVE", "Failed to encode the signature image")
            }
          }
        }
      }
    }
  }
}
