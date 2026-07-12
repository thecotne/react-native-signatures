# react-native-signatures

A signature pad for React Native (iOS, Android, Web) built on the **Expo Modules API**
and **platform-native 2D graphics** — Core Graphics on iOS, `Canvas`/`Path` on Android,
HTML Canvas 2D on web. The ink uses
[signature_pad](https://github.com/szimek/signature_pad)'s velocity-based,
variable-width Bézier algorithm, ported natively to each platform.

**No bundled graphics engine.** No Skia binary, no CanvasKit WASM — the rendering
runtimes are all OS-provided, so the only thing your app ships is this module's own
small native code.

- New-architecture (Fabric) compatible via Expo Modules.
- Smooth, pen-like ink: velocity → variable stroke width, midpoint Bézier smoothing,
  coalesced (iOS) / historical (Android) touch samples for high-frequency input.
- Export to bare base64 PNG or JPEG, with optional background baking and trimming.
- The algorithm is pinned by golden test vectors (`test-fixtures/signature-golden.json`)
  shared by the TypeScript reference (`src/signatureMath.ts`) and the Swift/Kotlin
  ports, so the three platforms cannot silently drift apart.

## Installation

```sh
npx expo install react-native-signatures
```

A development build / prebuild is required (this is a native module); it will not run
in Expo Go.

## Usage

```tsx
import { useRef } from 'react';
import { Button } from 'react-native';
import SignatureView, { type SignatureViewRef } from 'react-native-signatures';

export function SignatureScreen({ onSign }: { onSign: (base64: string) => void }) {
  const ref = useRef<SignatureViewRef>(null);

  return (
    <>
      <SignatureView
        ref={ref}
        style={{ height: 260 }}
        backgroundColor="#fff"
        penColor="black"
        onChange={(e) => console.log('isEmpty:', e.nativeEvent.isEmpty)}
      />
      <Button title="Clear" onPress={() => ref.current?.clear()} />
      <Button title="Save" onPress={async () => onSign(await ref.current!.save())} />
    </>
  );
}
```

The module ships only the drawing surface and ref methods — modals, previews, and
Save/Clear buttons stay in the host app so it controls the styling.

Drawing inside scrollable containers works out of the box: the view claims the
gesture on touch-down (a zero-delay recognizer on iOS,
`requestDisallowInterceptTouchEvent` on Android), so an ancestor `ScrollView`
scrolls only when the drag starts outside the pad.

## Props

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `penColor` | `string` | `"black"` | Ink color (any CSS color). |
| `minWidth` | `number` | `0.5` | Minimum stroke half-width (dp/points), reached at high velocity. |
| `maxWidth` | `number` | `2.5` | Maximum stroke half-width, reached at zero velocity. |
| `velocityFilterWeight` | `number` | `0.7` | Low-pass filter weight for velocity smoothing (`0..1`). |
| `minDistance` | `number` | `5` | Samples closer than this to the last accepted one are dropped. |
| `dotSize` | `number` | `0` | Tap-dot radius; `0` means `(minWidth + maxWidth) / 2`. |
| `backgroundColor` | `string` | transparent | Visible background of the pad (not baked into exports). |
| `onBegin` | `() => void` | — | First touch of a stroke. |
| `onEnd` | `() => void` | — | Stroke ended. |
| `onChange` | `(e) => void` | — | `e.nativeEvent.isEmpty`; fired on emptiness changes and after each stroke. |

All other `ViewProps` (`style`, `testID`, …) are passed through.

## Ref methods

```ts
interface SignatureViewRef {
  clear(): Promise<void>;
  isEmpty(): Promise<boolean>;
  save(options?: SaveOptions): Promise<string>; // bare base64, no data: prefix
}

type SaveOptions = {
  format?: 'png' | 'jpeg'; // default "png"
  quality?: number; // JPEG only, 0..1, default 0.92
  backgroundColor?: string; // baked into the export; JPEG defaults to white
  trim?: boolean; // crop to the ink bounding box
};
```

## Alternatives

Solid libraries exist for the same job — the trade-off is which runtime
dependencies they bring along:

| Library | Rendering | Extra React Native modules required | Platforms |
| --- | --- | --- | --- |
| **react-native-signatures** (this) | Platform-native 2D: Core Graphics (iOS), `Canvas`/`Path` (Android), HTML Canvas 2D (web) | **none** | iOS · Android · Web |
| [react-native-signature-canvas](https://github.com/YanYuanFE/react-native-signature-canvas) | signature_pad running inside a WebView | `react-native-webview` | iOS · Android · Expo |
| [@amwebexpert/react-native-sign-here](https://www.npmjs.com/package/@amwebexpert/react-native-sign-here) | SVG paths driven by gestures | `react-native-svg`, `react-native-gesture-handler`, `react-native-reanimated` | iOS · Android |
| [react-native-signature-capture](https://github.com/RepairShopr/react-native-signature-capture) | Native views (old architecture) | none | iOS · Android |
| [react-signature-canvas](https://www.npmjs.com/package/react-signature-canvas) | signature_pad on an HTML canvas (React DOM wrapper) | none (not a React Native library) | Web only |

How this module differs:

- **No other React Native modules.** No `react-native-svg`, no
  `react-native-gesture-handler`, no `react-native-reanimated`, no
  `react-native-webview` — nothing besides Expo Modules itself. The ink is
  drawn by each platform's own OS-provided 2D API, so the signature feature
  adds no graphics engine, WebView, or animation runtime to your bundle.
- **Native code on every platform.** Touch handling and rendering run in
  Swift (Core Graphics) on iOS and Kotlin (`Canvas`) on Android — no
  touch-point round-trips through JS while drawing — and on the browser's
  native canvas on web.
- **New-architecture ready.** Built on the Expo Modules API (Fabric), unlike
  `react-native-signature-capture`, which targets the old architecture and
  last shipped in 2021.
- Same ink model as `react-native-signature-canvas` (both implement
  signature_pad's algorithm), but without hosting a WebView to get it.
- **One component for all platforms.** `react-signature-canvas` covers web
  only, so pairing it with any native library means maintaining two
  signature code paths (`.tsx` + `.web.tsx`) with two different APIs. This
  module's web implementation ships built in, behind the same props and ref
  methods as iOS and Android.

## Development

```sh
npm install
npm run build        # tsc
npm test             # golden algorithm tests
cd example
npx expo run:ios     # or: npx expo run:android / npx expo start --web
```

If you intentionally change the ink algorithm, regenerate the golden vectors with
`node scripts/generate-golden-fixtures.cjs` and port the change to
`ios/SignatureView.swift` and `android/.../SignatureView.kt`.

## Attribution

The ink model is ported from
[szimek/signature_pad](https://github.com/szimek/signature_pad) (MIT License,
Copyright © Szymon Nowak), with reference to
[gcacace/android-signaturepad](https://github.com/gcacace/android-signaturepad)
(Apache-2.0) for the Android adaptation.

## License

MIT
