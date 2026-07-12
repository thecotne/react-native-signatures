# `react-native-signatures` — Implementation Plan

A standalone **Expo Module** that renders a signature pad using **platform-native 2D
graphics** — Core Graphics on iOS, `Canvas`/`Path` on Android, HTML Canvas 2D on web —
with **szimek/signature_pad's drawing algorithm** (velocity-based, variable-width Bézier
ink) ported to each platform.

The point: a smooth, pen-like signature on every platform with **no heavy bundled
graphics engine** — no Skia native lib, no CanvasKit WASM. The only thing shipped is the
module's own small native code; the rendering runtimes (CoreGraphics / Android Canvas /
browser canvas) are all OS-provided.

---

## 1. Goals & non-goals

**Goals**
- One reusable signature component across iOS / Android / Web.
- High-fidelity ink: velocity → variable stroke width + Bézier smoothing (signature_pad parity).
- Capture to a base64 PNG (and optionally raw vector/point data).
- New-architecture (Fabric / Expo Modules) compatible — the thing dev's old
  `react-native-signature-capture` was not.
- Zero extra *graphics* dependencies bundled into the host app.

**Non-goals**
- General-purpose 2D canvas API (this is a focused signature view, not a Skia replacement).
- Pixel-identical cross-platform output (each platform rasterizes with its own AA; we aim
  for *visually equivalent*, validated by golden tests on the algorithm, not the pixels).
- Shipping app chrome — the modal, preview, and Save/Clear buttons stay in the host app
  so it controls styling. The module exposes the drawing surface + `clear()`/`save()`.

---

## 2. Why this design (recap of the trade-off)

| | Skia (`@shopify/react-native-skia`) | **this module** | `react-native-svg` + signature_pad |
|---|---|---|---|
| Bundled graphics dep | Skia native lib (+CanvasKit WASM on web) | **none** (OS APIs only) | rn-svg (light, no WASM) |
| Native code to maintain | none | **a lot (you own it)** | none |
| Web payload | 2.9 MB WASM (or separate web file) | **0** (browser canvas) | 0 (DOM SVG) |
| Fidelity | constant-width unless extended | **signature_pad-quality** | signature_pad-quality |
| New-arch | ✓ | ✓ | ✓ |

This module is essentially **a modern, new-arch re-implementation of
`react-native-signature-capture`**: native CoreGraphics view (iOS) + native Canvas view
(Android) + a browser canvas (web), but built on the Expo Modules API and maintained by us.

---

## 3. Architecture

A **standalone** Expo Module (lives at this path, reusable / publishable; not a `--local`
module since it's a sibling of `NoonApp`, not inside it).

```
react-native-signatures/
├─ src/
│  ├─ index.ts                     # public API surface
│  ├─ ReactNativeSignaturesView.tsx# requireNativeView wrapper (native)
│  ├─ ReactNativeSignaturesView.web.tsx # <canvas> + signature_pad (web)
│  ├─ signatureMath.ts             # shared TS port of the algorithm (web + tests)
│  └─ types.ts                     # props / events / ref types
├─ ios/
│  ├─ ReactNativeSignaturesModule.swift  # Module + View definition
│  └─ SignatureView.swift          # ExpoView, Core Graphics drawing + touch
├─ android/src/main/java/expo/modules/signatures/
│  ├─ ReactNativeSignaturesModule.kt
│  └─ SignatureView.kt             # ExpoView, Canvas drawing + touch
├─ expo-module.config.json         # platforms: apple, android, web
├─ example/                        # standalone example app (dev harness, all 3 platforms)
└─ PLAN.md
```

Each platform provides a **native view** (`ExpoView` subclass) that owns touch handling,
ink geometry, incremental rendering, and export. The host app mounts the view, sets props,
and calls ref methods.

---

## 4. The signature_pad algorithm to port

`signature_pad` (MIT) and its Android port `gcacace/android-signaturepad` (Apache-2.0) use
the same model. Port this once per platform; keep params identical.

1. **Point capture** — on each touch sample record `(x, y, time)`.
2. **Velocity** — `v = distance(prev, cur) / Δt`.
3. **Width** — map velocity to width and smooth it:
   ```
   newWidth   = max(maxWidth / (v + 1), minWidth)        // faster ⇒ thinner
   width      = velocityFilterWeight * newWidth
              + (1 - velocityFilterWeight) * lastWidth    // low-pass smoothing
   ```
4. **Curve** — build a Bézier between consecutive points using midpoints as anchors and the
   raw points as control points (Catmull-Rom-style smoothing). For each curve, **interpolate
   width from startWidth → endWidth** along the segment.
5. **Render** — a variable-width stroke is drawn as a sequence of **filled** sub-segments
   (small filled circles/trapezoids whose radius = the interpolated half-width). This is why
   a single constant-width stroked path is insufficient — the ink is a *filled* shape.
6. **Dot** — a single tap draws a filled dot of radius `(minWidth + maxWidth) / 2 * dotSize`.

**Reference params** (defaults, expose as props): `minWidth = 0.5`, `maxWidth = 2.5`,
`velocityFilterWeight = 0.7`, `dotSize` auto, `penColor = "black"`,
`backgroundColor = transparent`.

---

## 5. Public API (TypeScript)

```ts
export type SignatureViewProps = {
  penColor?: string;            // default "black"
  minWidth?: number;            // default 0.5
  maxWidth?: number;            // default 2.5
  velocityFilterWeight?: number;// default 0.7
  backgroundColor?: string;     // default transparent
  onBegin?: () => void;         // first touch of a stroke session
  onEnd?: () => void;           // stroke session ended
  onChange?: (e: { nativeEvent: { isEmpty: boolean } }) => void;
} & ViewProps;

export type SaveOptions = {
  format?: "png" | "jpeg";      // default "png"
  quality?: number;             // jpeg only, 0..1
  backgroundColor?: string;     // bake a bg for the export (default keep transparent/white)
  trim?: boolean;               // crop to ink bounds
};

export interface SignatureViewRef {
  clear(): Promise<void>;
  isEmpty(): Promise<boolean>;
  save(options?: SaveOptions): Promise<string>; // bare base64 (no data: prefix)
  // optional / later:
  undo?(): Promise<void>;
  toData?(): Promise<StrokePoint[][]>;  // raw vector data
  fromData?(data: StrokePoint[][]): Promise<void>;
}
```

Native wiring (per the Expo Modules view DSL):
- `Prop("penColor")`, `Prop("minWidth")`, … set view fields; `OnViewDidUpdateProps` applies them.
- `Events("onBegin", "onEnd", "onChange")` dispatched via `EventDispatcher`.
- `AsyncFunction("clear")`, `AsyncFunction("isEmpty")`, `AsyncFunction("save")` — exposed on
  the view and callable through a React ref.

The module ships only the **view + ref methods**. The host app builds its own modal /
preview / Save+Clear buttons (so NoonApp keeps `SlideModal`/`Button` styling).

---

## 6. Key decision: where the algorithm runs

**Chosen: native per-platform (touch + geometry + draw all native), with a shared spec.**

- Touch latency matters for drawing; routing touch points to JS and back (option B) would
  add lag and defeat the purpose. So iOS/Android each implement the algorithm natively.
- **Web** reuses `signature_pad` directly (it *is* the canvas implementation).
- `src/signatureMath.ts` holds a **TS reference port** used by the web path and by unit
  tests; it doubles as the **golden-reference** the Swift/Kotlin ports are checked against
  (same input point/time sequences → same widths/curve control points).

This mirrors how `signature-capture` worked (native drawing), but with the algorithm pinned
by shared test vectors so the three platforms stay visually aligned.

> Shortcut: `gcacace/android-signaturepad` is the same algorithm already in Kotlin/Java
> (Apache-2.0). Adapt its source for the Android side (with attribution) instead of porting
> from scratch.

---

## 7. Per-platform implementation

### iOS — Swift, Core Graphics
- `SignatureView: ExpoView`.
- Touch via `UIPanGestureRecognizer` (or `touchesBegan/Moved/Ended`); `minimumPressDuration`/
  `minDistance` 0 so dots register.
- Keep a **backing `UIImage` buffer** (`UIGraphicsImageRenderer`/`CGContext`). On each move,
  draw only the **new** filled sub-segments into the buffer and `setNeedsDisplay()` —
  incremental, not a full redraw. Drawing in `draw(_:)` blits the buffer.
- Render at `UIScreen.main.scale` for crisp export.
- `save()` → buffer `UIImage` → `pngData()`/`jpegData()` → `base64EncodedString()`.
- `clear()` → reset buffer + points; dispatch `onChange(isEmpty: true)`.

### Android — Kotlin, Canvas/Path
- `SignatureView: ExpoView` wrapping a custom `View` (or draw directly in `onDraw`).
- `onTouchEvent` for `ACTION_DOWN/MOVE/UP`.
- Keep a **mutable `Bitmap` + `Canvas`**; draw new filled sub-segments incrementally,
  `invalidate()`.
- Adapt `gcacace/android-signaturepad`'s `Bezier`/`ControlTimedPoints`/velocity-width logic.
- `save()` → `Bitmap.compress(PNG/JPEG)` → `Base64.encodeToString(..., NO_WRAP)`.
- `clear()` → recreate bitmap; emit `onChange`.

### Web — TypeScript, Canvas 2D
- `ReactNativeSignaturesView.web.tsx`: a React component rendering `<canvas>`, instantiating
  `signature_pad` with the mapped props.
- Wire ref methods to signature_pad: `clear()`, `isEmpty()`, and
  `save → toDataURL(...)` (strip the `data:image/png;base64,` prefix to honor the bare-base64
  contract). `onBegin`/`onEnd` from signature_pad callbacks.
- Handle devicePixelRatio scaling (signature_pad's standard resize handling).

---

## 8. Scaffolding

```bash
# standalone module, all three platforms, native view + view events
npx create-expo-module@latest react-native-signatures \
  --platform apple android web \
  --features View ViewEvent \
  --name ReactNativeSignatures \
  --package expo.modules.signatures
```

Then replace the generated example view with the signature implementation. Keep the
`example/` app — it's the dev harness to draw/clear/save on iOS, Android, and web.

`expo-module.config.json`:
```json
{
  "platforms": ["apple", "android", "web"],
  "apple":   { "modules": ["ReactNativeSignaturesModule"] },
  "android": { "modules": ["expo.modules.signatures.ReactNativeSignaturesModule"] }
}
```

---

## 9. Capture / export contract

`save()` returns **bare base64** (no `data:` prefix) to match NoonApp's existing
`onSign(base64)` contract. Options: `format` (png/jpeg), `quality`, `backgroundColor`
(bake white if the consumer can't handle transparency), `trim` (crop to ink bounds).
Per platform: iOS `UIImage→pngData`, Android `Bitmap.compress`, Web `canvas.toDataURL`.

---

## 10. Integration into NoonApp

1. Add dependency (local file path during dev: `"react-native-signatures": "file:../react-native-signatures"`; or publish to npm later).
2. Collapse `src/components/signaturePad.tsx` **and** `signaturePad.web.tsx` into **one**
   `signaturePad.tsx` that wraps `SignatureView`, keeping the current `SignaturePadProps`
   contract (`title`, `base64Signature`, `onSign`, `containerStyle`). The modal/preview/
   buttons stay; Save calls `ref.save()`, Clear calls `ref.clear()`.
3. Remove signature usage of `@shopify/react-native-skia` and the `react-signature-canvas`
   web dep → **net dependency reduction** for the app.
4. `prebuild`/dev-client rebuild required (new native module).

---

## 11. Testing

- **Algorithm golden tests** (`signatureMath.test.ts`): fixed `(x,y,t)` sequences →
  assert width series + Bézier control points. The Swift/Kotlin ports are validated against
  these same vectors (port the fixtures) so platforms can't silently drift.
- **Example app**: manual draw/clear/save on all three platforms; eyeball ink quality and
  exported PNG.
- **NoonApp**: existing jest contract tests stay; mock the native view
  (`jest.mock('react-native-signatures')`) returning a stub with `save`/`clear`.
- Optional: native snapshot/image diff for regressions.

---

## 12. Milestones

- **Phase 0 — Scaffold.** `create-expo-module`; example app builds & runs on iOS/Android/web with the stub view.
- **Phase 1 — Web first.** Wire `signature_pad` + the full TS API/contract. Fastest path; locks the API.
- **Phase 2 — iOS.** Core Graphics view, touch, incremental buffer, save/clear, events.
- **Phase 3 — Android.** Canvas view adapting gcacace; save/clear, events.
- **Phase 4 — Polish.** Props (colors/widths/bg), `onChange`, `trim`, retina scaling, optional `undo`/`toData`/`fromData`.
- **Phase 5 — Integrate into NoonApp.** Single `signaturePad.tsx`; drop Skia + react-signature-canvas for signatures.
- **Phase 6 — (optional) Publish** to npm / private registry.

Rough effort: Web ~0.5–1d · iOS ~2–3d · Android ~2–3d (less if adapting gcacace) ·
integration ~0.5d · polish/tests ~1–2d.

---

## 13. Risks & open questions

- **Incremental-render performance.** Re-drawing the full path each frame is too slow for
  long signatures — must use a backing buffer/bitmap and draw only new segments. (Primary risk.)
- **Cross-platform visual parity.** AA and width mapping differ slightly per rasterizer;
  the golden-vector tests bound the *geometry*, not the pixels — accept minor look differences.
- **Background/transparency.** Some exports bake black if no bg is set; default to transparent
  and offer a `backgroundColor` bake option.
- **Retina/scale & export resolution.** Render at native scale; consider an explicit export
  size/scale option for consistent server-side image dimensions.
- **Licensing/attribution.** signature_pad = MIT, android-signaturepad = Apache-2.0 — keep
  NOTICE/license headers when adapting source.
- **Web Expo-module view registration.** Confirm the web view wiring (`.web.tsx` component
  resolution) against the installed Expo SDK during Phase 0.
- **Old vs new arch.** Expo Modules supports both; no action expected, but verify in the
  example app.

---

## 14. Definition of done

- Example app: draw → smooth variable-width ink, Clear resets, Save returns a valid base64
  PNG, on iOS + Android + Web.
- NoonApp: a single `signaturePad.tsx` backed by this module; Skia + react-signature-canvas
  removed from the signature path; existing jest contract tests pass.
- No CanvasKit/WASM and no Skia binary contributed by the signature feature.
