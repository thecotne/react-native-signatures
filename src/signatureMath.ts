/**
 * Reference implementation of the signature ink algorithm, ported from
 * signature_pad (https://github.com/szimek/signature_pad), MIT License,
 * Copyright (c) 2023 Szymon Nowak.
 *
 * This file is the cross-platform golden reference: the web renderer draws
 * straight from it, and the Swift (iOS) and Kotlin (Android) ports are
 * line-by-line translations validated against the same fixture vectors
 * (see `test-fixtures/signature-golden.json`). Keep the three in sync.
 *
 * Model: each accepted touch sample `(x, y, time)` yields velocity
 * `v = distance / Δt` (units per ms), low-pass filtered; width maps as
 * `max(maxWidth / (v + 1), minWidth)`. Consecutive samples are joined by a
 * cubic Bézier (midpoint smoothing) and the variable-width stroke is
 * rasterized as a run of filled circles whose radius interpolates
 * startWidth → endWidth along the curve.
 */

export interface StrokePoint {
  x: number;
  y: number;
  /** Timestamp in milliseconds. Only deltas matter. */
  time: number;
}

export interface SignatureInkOptions {
  minWidth: number;
  maxWidth: number;
  velocityFilterWeight: number;
  minDistance: number;
  dotSize: number;
}

export const DEFAULT_INK_OPTIONS: SignatureInkOptions = {
  minWidth: 0.5,
  maxWidth: 2.5,
  velocityFilterWeight: 0.7,
  minDistance: 5,
  dotSize: 0,
};

export interface CurveSegment {
  startPoint: StrokePoint;
  control1: { x: number; y: number };
  control2: { x: number; y: number };
  endPoint: StrokePoint;
  startWidth: number;
  endWidth: number;
}

export interface InkDot {
  x: number;
  y: number;
  radius: number;
}

export type InkCommand = { type: 'dot'; dot: InkDot } | { type: 'curve'; curve: CurveSegment };

export interface AddPointResult {
  /** `false` when the sample was dropped for being within `minDistance` of the previous one. */
  accepted: boolean;
  /** Ink to draw for this sample; `null` while the curve window is still buffering. */
  command: InkCommand | null;
}

export function distanceBetween(a: StrokePoint, b: StrokePoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Velocity between two samples in units/ms; 0 when timestamps coincide. */
export function velocityFrom(start: StrokePoint, end: StrokePoint): number {
  return end.time !== start.time ? distanceBetween(end, start) / (end.time - start.time) : 0;
}

/** Velocity → stroke half-width: faster ⇒ thinner. */
export function strokeWidth(velocity: number, options: SignatureInkOptions): number {
  return Math.max(options.maxWidth / (velocity + 1), options.minWidth);
}

/** Radius of the dot drawn for a single tap. */
export function dotRadius(options: SignatureInkOptions): number {
  return options.dotSize > 0 ? options.dotSize : (options.minWidth + options.maxWidth) / 2;
}

/**
 * Catmull-Rom-style control points for the middle segment of three samples.
 * Identical to signature_pad's `Bezier.calculateControlPoints`, with a guard
 * for the (filtered-out in practice) degenerate case of coincident points.
 */
export function calculateControlPoints(
  s1: StrokePoint,
  s2: StrokePoint,
  s3: StrokePoint
): { c1: { x: number; y: number }; c2: { x: number; y: number } } {
  const dx1 = s1.x - s2.x;
  const dy1 = s1.y - s2.y;
  const dx2 = s2.x - s3.x;
  const dy2 = s2.y - s3.y;

  const m1 = { x: (s1.x + s2.x) / 2.0, y: (s1.y + s2.y) / 2.0 };
  const m2 = { x: (s2.x + s3.x) / 2.0, y: (s2.y + s3.y) / 2.0 };

  const l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
  const l2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

  const dxm = m1.x - m2.x;
  const dym = m1.y - m2.y;

  const k = l1 + l2 === 0 ? 0 : l2 / (l1 + l2);
  const cm = { x: m2.x + dxm * k, y: m2.y + dym * k };

  const tx = s2.x - cm.x;
  const ty = s2.y - cm.y;

  return {
    c1: { x: m1.x + tx, y: m1.y + ty },
    c2: { x: m2.x + tx, y: m2.y + ty },
  };
}

/**
 * Build the drawable curve for a 4-sample window: the curve spans
 * `points[1] → points[2]`, using the outer samples for smoothing.
 */
export function bezierFromPoints(
  points: readonly [StrokePoint, StrokePoint, StrokePoint, StrokePoint],
  widths: { start: number; end: number }
): CurveSegment {
  const c2 = calculateControlPoints(points[0], points[1], points[2]).c2;
  const c3 = calculateControlPoints(points[1], points[2], points[3]).c1;
  return {
    startPoint: points[1],
    control1: c2,
    control2: c3,
    endPoint: points[2],
    startWidth: widths.start,
    endWidth: widths.end,
  };
}

/** Cubic Bézier interpolation of one scalar component. */
export function bezierPointAt(
  t: number,
  start: number,
  c1: number,
  c2: number,
  end: number
): number {
  return (
    start * (1.0 - t) * (1.0 - t) * (1.0 - t) +
    3.0 * c1 * (1.0 - t) * (1.0 - t) * t +
    3.0 * c2 * (1.0 - t) * t * t +
    end * t * t * t
  );
}

/** Approximate curve length via a 10-step polyline, as signature_pad does. */
export function bezierLength(curve: CurveSegment): number {
  const steps = 10;
  let length = 0;
  let px = 0;
  let py = 0;

  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const cx = bezierPointAt(
      t,
      curve.startPoint.x,
      curve.control1.x,
      curve.control2.x,
      curve.endPoint.x
    );
    const cy = bezierPointAt(
      t,
      curve.startPoint.y,
      curve.control1.y,
      curve.control2.y,
      curve.endPoint.y
    );
    if (i > 0) {
      const xdiff = cx - px;
      const ydiff = cy - py;
      length += Math.sqrt(xdiff * xdiff + ydiff * ydiff);
    }
    px = cx;
    py = cy;
  }
  return length;
}

/**
 * Rasterization plan for a curve: the run of filled circles renderers draw.
 * Mirrors signature_pad's `_drawCurve` — `ceil(length) * 2` steps, width
 * eased along the segment by `t³` and clamped to `maxWidth`.
 */
export function flattenCurve(curve: CurveSegment, maxWidth: number): InkDot[] {
  const widthDelta = curve.endWidth - curve.startWidth;
  const drawSteps = Math.ceil(bezierLength(curve)) * 2;
  const dots: InkDot[] = [];

  for (let i = 0; i < drawSteps; i += 1) {
    const t = i / drawSteps;
    const tt = t * t;
    const ttt = tt * t;
    const u = 1 - t;
    const uu = u * u;
    const uuu = uu * u;

    let x = uuu * curve.startPoint.x;
    x += 3 * uu * t * curve.control1.x;
    x += 3 * u * tt * curve.control2.x;
    x += ttt * curve.endPoint.x;

    let y = uuu * curve.startPoint.y;
    y += 3 * uu * t * curve.control1.y;
    y += 3 * u * tt * curve.control2.y;
    y += ttt * curve.endPoint.y;

    const width = Math.min(curve.startWidth + ttt * widthDelta, maxWidth);
    dots.push({ x, y, radius: width });
  }
  return dots;
}

/**
 * Incremental stroke state machine. Feed it every accepted touch sample of
 * one stroke; it answers with what to draw for that sample (nothing, a dot,
 * or one Bézier segment). Equivalent to signature_pad's
 * `_reset`/`_strokeUpdate`/`_addPoint`/`_calculateCurveWidths`.
 */
export class StrokeBuilder {
  private readonly options: SignatureInkOptions;
  private window: StrokePoint[] = [];
  private lastVelocity = 0;
  private lastWidth: number;

  constructor(options: Partial<SignatureInkOptions> = {}) {
    this.options = { ...DEFAULT_INK_OPTIONS, ...options };
    this.lastWidth = (this.options.minWidth + this.options.maxWidth) / 2;
  }

  /** Reset filter state. Call at the start of every stroke. */
  begin(): void {
    this.window = [];
    this.lastVelocity = 0;
    this.lastWidth = (this.options.minWidth + this.options.maxWidth) / 2;
  }

  /** Feed one sample and learn what (if anything) to draw for it. */
  add(point: StrokePoint): AddPointResult {
    const last = this.window.length > 0 ? this.window[this.window.length - 1] : null;
    if (last && distanceBetween(point, last) <= this.options.minDistance) {
      return { accepted: false, command: null };
    }

    const curve = this.pushToWindow(point);
    if (!last) {
      return {
        accepted: true,
        command: {
          type: 'dot',
          dot: { x: point.x, y: point.y, radius: dotRadius(this.options) },
        },
      };
    }
    return { accepted: true, command: curve ? { type: 'curve', curve } : null };
  }

  private pushToWindow(point: StrokePoint): CurveSegment | null {
    this.window.push(point);
    if (this.window.length > 2) {
      // To reduce initial lag, the first curve reuses the first point as
      // its leading neighbor.
      if (this.window.length === 3) {
        this.window.unshift(this.window[0]);
      }
      const widths = this.calculateCurveWidths(this.window[1], this.window[2]);
      const curve = bezierFromPoints(
        this.window as unknown as [StrokePoint, StrokePoint, StrokePoint, StrokePoint],
        widths
      );
      this.window.shift();
      return curve;
    }
    return null;
  }

  private calculateCurveWidths(
    startPoint: StrokePoint,
    endPoint: StrokePoint
  ): { start: number; end: number } {
    const velocity =
      this.options.velocityFilterWeight * velocityFrom(startPoint, endPoint) +
      (1 - this.options.velocityFilterWeight) * this.lastVelocity;

    const newWidth = strokeWidth(velocity, this.options);
    const widths = { end: newWidth, start: this.lastWidth };

    this.lastVelocity = velocity;
    this.lastWidth = newWidth;
    return widths;
  }
}

/**
 * Replay a full stroke (e.g. after a canvas resize) through a fresh builder.
 */
export function buildStrokeCommands(
  points: readonly StrokePoint[],
  options: Partial<SignatureInkOptions> = {}
): InkCommand[] {
  const builder = new StrokeBuilder(options);
  builder.begin();
  const commands: InkCommand[] = [];
  for (const point of points) {
    const { command } = builder.add(point);
    if (command) {
      commands.push(command);
    }
  }
  return commands;
}
