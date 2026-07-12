import * as React from 'react';
import { View } from 'react-native';

import {
  DEFAULT_INK_OPTIONS,
  StrokeBuilder,
  buildStrokeCommands,
  flattenCurve,
  type InkCommand,
  type InkDot,
  type SignatureInkOptions,
  type StrokePoint,
} from './signatureMath';
import type { SaveOptions, SignatureViewProps, SignatureViewRef } from './types';

type InkBounds = { minX: number; minY: number; maxX: number; maxY: number };

type StoredStroke = {
  points: StrokePoint[];
  options: SignatureInkOptions;
  color: string;
};

type DrawState = {
  ctx: CanvasRenderingContext2D | null;
  dpr: number;
  cssWidth: number;
  cssHeight: number;
  builder: StrokeBuilder | null;
  activePointerId: number | null;
  currentStroke: StoredStroke | null;
  strokes: StoredStroke[];
  inkBounds: InkBounds | null;
  isEmpty: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function drawSegment(ctx: CanvasRenderingContext2D, dot: InkDot) {
  ctx.moveTo(dot.x, dot.y);
  ctx.arc(dot.x, dot.y, dot.radius, 0, 2 * Math.PI, false);
}

function growBounds(bounds: InkBounds | null, dot: InkDot): InkBounds {
  const minX = dot.x - dot.radius;
  const minY = dot.y - dot.radius;
  const maxX = dot.x + dot.radius;
  const maxY = dot.y + dot.radius;
  if (!bounds) {
    return { minX, minY, maxX, maxY };
  }
  bounds.minX = Math.min(bounds.minX, minX);
  bounds.minY = Math.min(bounds.minY, minY);
  bounds.maxX = Math.max(bounds.maxX, maxX);
  bounds.maxY = Math.max(bounds.maxY, maxY);
  return bounds;
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
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const stateRef = React.useRef<DrawState>({
    ctx: null,
    dpr: 1,
    cssWidth: 0,
    cssHeight: 0,
    builder: null,
    activePointerId: null,
    currentStroke: null,
    strokes: [],
    inkBounds: null,
    isEmpty: true,
  });

  // Latest props, readable from the stable DOM event handlers.
  const propsRef = React.useRef({
    penColor,
    inkOptions: DEFAULT_INK_OPTIONS,
    onBegin,
    onEnd,
    onChange,
  });
  propsRef.current = {
    penColor,
    inkOptions: {
      minWidth,
      maxWidth,
      velocityFilterWeight,
      minDistance,
      dotSize,
    },
    onBegin,
    onEnd,
    onChange,
  };

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    const state = stateRef.current;
    state.ctx = canvas.getContext('2d');

    const emitChange = (isEmpty: boolean) => {
      propsRef.current.onChange?.({ nativeEvent: { isEmpty } });
    };

    const trackCommandBounds = (command: InkCommand, commandMaxWidth: number) => {
      if (command.type === 'dot') {
        state.inkBounds = growBounds(state.inkBounds, command.dot);
      } else {
        for (const dot of flattenCurve(command.curve, commandMaxWidth)) {
          state.inkBounds = growBounds(state.inkBounds, dot);
        }
      }
    };

    const markNotEmpty = () => {
      if (state.isEmpty) {
        state.isEmpty = false;
        emitChange(false);
      }
    };

    const clearCanvasPixels = () => {
      const ctx = state.ctx;
      if (!ctx) {
        return;
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    };

    const drawCommand = (
      ctx: CanvasRenderingContext2D,
      command: InkCommand,
      color: string,
      commandMaxWidth: number
    ) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      if (command.type === 'dot') {
        drawSegment(ctx, command.dot);
      } else {
        for (const dot of flattenCurve(command.curve, commandMaxWidth)) {
          drawSegment(ctx, dot);
        }
      }
      ctx.closePath();
      ctx.fill();
    };

    const redrawFromStrokes = () => {
      const ctx = state.ctx;
      if (!ctx) {
        return;
      }
      clearCanvasPixels();
      state.inkBounds = null;
      for (const stroke of state.strokes) {
        for (const command of buildStrokeCommands(stroke.points, stroke.options)) {
          drawCommand(ctx, command, stroke.color, stroke.options.maxWidth);
          trackCommandBounds(command, stroke.options.maxWidth);
        }
      }
    };

    const resizeCanvas = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const width = Math.max(1, Math.round(rect.width * dpr));
      const height = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width === width && canvas.height === height && state.dpr === dpr) {
        state.cssWidth = rect.width;
        state.cssHeight = rect.height;
        return;
      }
      canvas.width = width;
      canvas.height = height;
      state.dpr = dpr;
      state.cssWidth = rect.width;
      state.cssHeight = rect.height;
      state.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      redrawFromStrokes();
    };

    const toLocalPoint = (event: PointerEvent): StrokePoint => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        time: event.timeStamp,
      };
    };

    const feed = (event: PointerEvent) => {
      const { builder, currentStroke, ctx } = state;
      if (!builder || !currentStroke || !ctx) {
        return;
      }
      const coalesced: PointerEvent[] =
        typeof event.getCoalescedEvents === 'function' && event.getCoalescedEvents().length > 0
          ? event.getCoalescedEvents()
          : [event];
      for (const sample of coalesced) {
        const point = toLocalPoint(sample);
        const { accepted, command } = builder.add(point);
        if (accepted) {
          currentStroke.points.push(point);
        }
        if (command) {
          drawCommand(ctx, command, currentStroke.color, currentStroke.options.maxWidth);
          trackCommandBounds(command, currentStroke.options.maxWidth);
          markNotEmpty();
        }
      }
    };

    const finishStroke = () => {
      if (state.currentStroke && state.currentStroke.points.length > 0) {
        state.strokes.push(state.currentStroke);
      }
      state.currentStroke = null;
      state.builder = null;
      state.activePointerId = null;
      propsRef.current.onEnd?.();
      emitChange(state.isEmpty);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (state.activePointerId != null) {
        return;
      }
      if (event.pointerType === 'mouse' && event.button !== 0) {
        return;
      }
      event.preventDefault();
      try {
        canvas.setPointerCapture?.(event.pointerId);
      } catch {
        // Untracked pointerId (e.g. synthetic events) — capture is best-effort.
      }
      state.activePointerId = event.pointerId;
      state.builder = new StrokeBuilder(propsRef.current.inkOptions);
      state.builder.begin();
      state.currentStroke = {
        points: [],
        options: { ...propsRef.current.inkOptions },
        color: propsRef.current.penColor,
      };
      propsRef.current.onBegin?.();
      feed(event);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== state.activePointerId) {
        return;
      }
      event.preventDefault();
      feed(event);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== state.activePointerId) {
        return;
      }
      event.preventDefault();
      feed(event);
      finishStroke();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId !== state.activePointerId) {
        return;
      }
      finishStroke();
    };

    canvas.addEventListener('pointerdown', handlePointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerup', handlePointerUp);
    canvas.addEventListener('pointercancel', handlePointerCancel);

    let resizeObserver: ResizeObserver | null = null;
    let resizeListener: (() => void) | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(resizeCanvas);
      resizeObserver.observe(canvas);
    } else if (typeof window !== 'undefined') {
      resizeListener = resizeCanvas;
      window.addEventListener('resize', resizeListener);
    }
    resizeCanvas();

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown);
      canvas.removeEventListener('pointermove', handlePointerMove);
      canvas.removeEventListener('pointerup', handlePointerUp);
      canvas.removeEventListener('pointercancel', handlePointerCancel);
      resizeObserver?.disconnect();
      if (resizeListener && typeof window !== 'undefined') {
        window.removeEventListener('resize', resizeListener);
      }
    };
  }, []);

  React.useImperativeHandle(
    ref,
    () => ({
      async clear() {
        const state = stateRef.current;
        const canvas = canvasRef.current;
        state.strokes = [];
        state.currentStroke = null;
        state.builder = null;
        state.activePointerId = null;
        state.inkBounds = null;
        const ctx = state.ctx;
        if (ctx && canvas) {
          ctx.save();
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.restore();
        }
        if (!state.isEmpty) {
          state.isEmpty = true;
          propsRef.current.onChange?.({ nativeEvent: { isEmpty: true } });
        }
      },
      async isEmpty() {
        return stateRef.current.isEmpty;
      },
      async save(options?: SaveOptions) {
        const canvas = canvasRef.current;
        const state = stateRef.current;
        if (!canvas) {
          throw new Error('SignatureView is not mounted');
        }
        const format = options?.format === 'jpeg' ? 'jpeg' : 'png';
        const quality = clamp(options?.quality ?? 0.92, 0, 1);
        const trim = options?.trim === true;

        // Export region in device pixels.
        let sx = 0;
        let sy = 0;
        let sw = canvas.width;
        let sh = canvas.height;
        if (trim && state.inkBounds) {
          const { dpr } = state;
          sx = clamp(Math.floor(state.inkBounds.minX * dpr), 0, canvas.width);
          sy = clamp(Math.floor(state.inkBounds.minY * dpr), 0, canvas.height);
          sw = clamp(Math.ceil(state.inkBounds.maxX * dpr) - sx, 1, canvas.width - sx);
          sh = clamp(Math.ceil(state.inkBounds.maxY * dpr) - sy, 1, canvas.height - sy);
        }

        const output = document.createElement('canvas');
        output.width = Math.max(1, sw);
        output.height = Math.max(1, sh);
        const outputCtx = output.getContext('2d');
        if (!outputCtx) {
          throw new Error('Could not acquire a 2D canvas context for export');
        }
        const bakedBackground =
          options?.backgroundColor ?? (format === 'jpeg' ? '#ffffff' : undefined);
        if (bakedBackground) {
          outputCtx.fillStyle = bakedBackground;
          outputCtx.fillRect(0, 0, output.width, output.height);
        }
        outputCtx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);

        const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const dataUrl = output.toDataURL(mime, quality);
        return dataUrl.slice(dataUrl.indexOf(',') + 1);
      },
    }),
    []
  );

  return (
    <View {...viewProps} style={[backgroundColor != null ? { backgroundColor } : null, style]}>
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
          userSelect: 'none',
        }}
      />
    </View>
  );
});

export default SignatureView;
