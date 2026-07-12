import { requireNativeView } from 'expo';
import * as React from 'react';
import { processColor, type NativeSyntheticEvent, type ViewProps } from 'react-native';

import type {
  SaveOptions,
  SignatureChangeEvent,
  SignatureViewProps,
  SignatureViewRef,
} from './types';

/**
 * Props as the native view receives them: colors are pre-processed to ARGB
 * ints in JS so iOS and Android share one number-based contract.
 */
type NativeSignatureViewProps = {
  penColor?: number;
  // Deliberately NOT named minWidth/maxWidth: those are reserved Yoga layout
  // prop names, and Fabric would clamp the view's size with them.
  minStrokeWidth?: number;
  maxStrokeWidth?: number;
  velocityFilterWeight?: number;
  minDistance?: number;
  dotSize?: number;
  onBegin?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  onEnd?: (event: NativeSyntheticEvent<Record<string, never>>) => void;
  // Deliberately NOT named onChange: the generated native event name
  // `topChange` would collide with React Native's built-in bubbling event.
  onInkChange?: (event: SignatureChangeEvent) => void;
} & ViewProps;

type NativeSaveOptions = {
  format: 'png' | 'jpeg';
  quality: number;
  backgroundColor?: number;
  trim: boolean;
};

type NativeSignatureViewRef = {
  clear(): Promise<void>;
  isEmpty(): Promise<boolean>;
  save(options: NativeSaveOptions): Promise<string>;
};

const NativeView = requireNativeView<
  NativeSignatureViewProps & React.RefAttributes<NativeSignatureViewRef>
>('ReactNativeSignatures');

function toNativeColor(color: string | undefined): number | undefined {
  if (color == null) {
    return undefined;
  }
  const processed = processColor(color);
  return typeof processed === 'number' ? processed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizeSaveOptions(options?: SaveOptions): NativeSaveOptions {
  const normalized: NativeSaveOptions = {
    format: options?.format === 'jpeg' ? 'jpeg' : 'png',
    quality: clamp(options?.quality ?? 0.92, 0, 1),
    trim: options?.trim === true,
  };
  const backgroundColor = toNativeColor(options?.backgroundColor);
  if (backgroundColor !== undefined) {
    normalized.backgroundColor = backgroundColor;
  }
  return normalized;
}

const SignatureView = React.forwardRef<SignatureViewRef, SignatureViewProps>(function SignatureView(
  {
    penColor = 'black',
    minWidth = 0.5,
    maxWidth = 2.5,
    velocityFilterWeight = 0.7,
    minDistance = 5,
    dotSize = 0,
    backgroundColor,
    style,
    onBegin,
    onEnd,
    onChange,
    ...viewProps
  },
  ref
) {
  const nativeRef = React.useRef<NativeSignatureViewRef>(null);

  React.useImperativeHandle(
    ref,
    () => ({
      async clear() {
        await nativeRef.current?.clear();
      },
      async isEmpty() {
        return (await nativeRef.current?.isEmpty()) ?? true;
      },
      async save(options?: SaveOptions) {
        const view = nativeRef.current;
        if (!view) {
          throw new Error('SignatureView is not mounted');
        }
        return view.save(normalizeSaveOptions(options));
      },
    }),
    []
  );

  return (
    <NativeView
      {...viewProps}
      ref={nativeRef}
      penColor={toNativeColor(penColor)}
      minStrokeWidth={minWidth}
      maxStrokeWidth={maxWidth}
      velocityFilterWeight={velocityFilterWeight}
      minDistance={minDistance}
      dotSize={dotSize}
      style={[backgroundColor != null ? { backgroundColor } : null, style]}
      onBegin={onBegin}
      onEnd={onEnd}
      onInkChange={onChange}
    />
  );
});

export default SignatureView;
