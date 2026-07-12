import golden from '../../test-fixtures/signature-golden.json';
import {
  DEFAULT_INK_OPTIONS,
  StrokeBuilder,
  buildStrokeCommands,
  calculateControlPoints,
  distanceBetween,
  dotRadius,
  flattenCurve,
  strokeWidth,
  velocityFrom,
  type CurveSegment,
  type InkCommand,
  type SignatureInkOptions,
  type StrokePoint,
} from '../signatureMath';

function point(x: number, y: number, time: number): StrokePoint {
  return { x, y, time };
}

function collect(builder: StrokeBuilder, points: StrokePoint[]): InkCommand[] {
  const commands: InkCommand[] = [];
  for (const p of points) {
    const { command } = builder.add(p);
    if (command) {
      commands.push(command);
    }
  }
  return commands;
}

describe('width model', () => {
  test('zero velocity yields maxWidth', () => {
    expect(strokeWidth(0, DEFAULT_INK_OPTIONS)).toBe(2.5);
  });

  test('high velocity clamps to minWidth', () => {
    expect(strokeWidth(1000, DEFAULT_INK_OPTIONS)).toBe(0.5);
  });

  test('velocity is distance per millisecond', () => {
    expect(velocityFrom(point(0, 0, 0), point(10, 0, 100))).toBeCloseTo(0.1, 12);
  });

  test('coincident timestamps yield zero velocity', () => {
    expect(velocityFrom(point(0, 0, 50), point(10, 0, 50))).toBe(0);
  });

  test('distance is Euclidean', () => {
    expect(distanceBetween(point(0, 0, 0), point(3, 4, 0))).toBe(5);
  });

  test('auto dot radius is the neutral width', () => {
    expect(dotRadius(DEFAULT_INK_OPTIONS)).toBe(1.5);
    expect(dotRadius({ ...DEFAULT_INK_OPTIONS, dotSize: 3 })).toBe(3);
  });
});

describe('control points', () => {
  test('collinear, evenly spaced samples produce midpoints', () => {
    const { c1, c2 } = calculateControlPoints(point(0, 0, 0), point(10, 0, 0), point(20, 0, 0));
    expect(c1).toEqual({ x: 5, y: 0 });
    expect(c2).toEqual({ x: 15, y: 0 });
  });

  test('degenerate (all-coincident) samples do not produce NaN', () => {
    const p = point(7, 7, 0);
    const { c1, c2 } = calculateControlPoints(p, p, p);
    expect(c1.x).not.toBeNaN();
    expect(c1.y).not.toBeNaN();
    expect(c2.x).not.toBeNaN();
    expect(c2.y).not.toBeNaN();
  });
});

describe('StrokeBuilder', () => {
  test('a single tap draws a dot at the touch point', () => {
    const builder = new StrokeBuilder();
    builder.begin();
    const { accepted, command } = builder.add(point(42.5, 17.25, 1000));
    expect(accepted).toBe(true);
    expect(command).toEqual({
      type: 'dot',
      dot: { x: 42.5, y: 17.25, radius: 1.5 },
    });
  });

  test('samples within minDistance of the last accepted sample are dropped (inclusive)', () => {
    const builder = new StrokeBuilder();
    builder.begin();
    expect(builder.add(point(0, 0, 0)).accepted).toBe(true);
    // Exactly 5 units away — dropped because the comparison is `<=`.
    expect(builder.add(point(3, 4, 16)).accepted).toBe(false);
    // Still measured against (0, 0), the last *accepted* sample.
    expect(builder.add(point(5, 0, 20)).accepted).toBe(false);
    expect(builder.add(point(5.1, 0, 24)).accepted).toBe(true);
  });

  test('constant-velocity horizontal line — hand-derived widths and control points', () => {
    // v = 10 units / 100 ms = 0.1 units/ms on every segment.
    const builder = new StrokeBuilder();
    builder.begin();
    const commands = collect(builder, [
      point(0, 0, 0),
      point(10, 0, 100),
      point(20, 0, 200),
      point(30, 0, 300),
    ]);

    expect(commands).toHaveLength(3);
    expect(commands[0].type).toBe('dot');

    // First curve: filtered velocity = 0.7·0.1 + 0.3·0 = 0.07,
    // so endWidth = 2.5 / 1.07; startWidth is the neutral (0.5+2.5)/2.
    const first = (commands[1] as { type: 'curve'; curve: CurveSegment }).curve;
    expect(first.startPoint).toMatchObject({ x: 0, y: 0 });
    expect(first.endPoint).toMatchObject({ x: 10, y: 0 });
    expect(first.control1).toEqual({ x: 5, y: 0 });
    expect(first.control2).toEqual({ x: 5, y: 0 });
    expect(first.startWidth).toBe(1.5);
    expect(first.endWidth).toBeCloseTo(2.5 / 1.07, 9);

    // Second curve: filtered velocity = 0.7·0.1 + 0.3·0.07 = 0.091,
    // so endWidth = 2.5 / 1.091; startWidth carries over.
    const second = (commands[2] as { type: 'curve'; curve: CurveSegment }).curve;
    expect(second.startPoint).toMatchObject({ x: 10, y: 0 });
    expect(second.endPoint).toMatchObject({ x: 20, y: 0 });
    expect(second.control1).toEqual({ x: 15, y: 0 });
    expect(second.control2).toEqual({ x: 15, y: 0 });
    expect(second.startWidth).toBeCloseTo(2.5 / 1.07, 9);
    expect(second.endWidth).toBeCloseTo(2.5 / 1.091, 9);
  });

  test('flattenCurve eases the width by t³ over ceil(length)·2 steps', () => {
    const builder = new StrokeBuilder();
    builder.begin();
    const commands = collect(builder, [point(0, 0, 0), point(10, 0, 100), point(20, 0, 200)]);
    const curve = (commands[1] as { type: 'curve'; curve: CurveSegment }).curve;
    const dots = flattenCurve(curve, DEFAULT_INK_OPTIONS.maxWidth);

    // The curve is a straight 10-unit segment → 20 steps.
    expect(dots).toHaveLength(20);
    expect(dots[0]).toEqual({ x: 0, y: 0, radius: 1.5 });
    // At t = 0.5: x = 5 and radius = 1.5 + 0.5³ · (endWidth − 1.5).
    expect(dots[10].x).toBeCloseTo(5, 9);
    expect(dots[10].radius).toBeCloseTo(1.5 + 0.125 * (2.5 / 1.07 - 1.5), 9);
    // Radii stay within the configured bounds.
    for (const dot of dots) {
      expect(dot.radius).toBeGreaterThanOrEqual(DEFAULT_INK_OPTIONS.minWidth);
      expect(dot.radius).toBeLessThanOrEqual(DEFAULT_INK_OPTIONS.maxWidth);
    }
  });

  test('begin() resets the width filter between strokes', () => {
    const points = [point(0, 0, 0), point(10, 0, 100), point(20, 0, 200)];
    const builder = new StrokeBuilder();
    builder.begin();
    const firstRun = collect(builder, points);
    builder.begin();
    const secondRun = collect(builder, points);
    expect(secondRun).toEqual(firstRun);
  });

  test('buildStrokeCommands replays a stroke identically', () => {
    const points = [point(12, 80, 10), point(30, 20, 90), point(48, 76, 130), point(66, 24, 210)];
    const builder = new StrokeBuilder();
    builder.begin();
    expect(buildStrokeCommands(points)).toEqual(collect(builder, points));
  });
});

describe('golden fixtures (cross-platform contract)', () => {
  // Mirrors scripts/generate-golden-fixtures.cjs — keep the two in sync.
  function round9(value: number): number {
    const rounded = Math.round(value * 1e9) / 1e9;
    return rounded === 0 ? 0 : rounded;
  }

  function serializePoint(p: { x: number; y: number }) {
    return { x: round9(p.x), y: round9(p.y) };
  }

  function serializeDot(dot: { x: number; y: number; radius: number }) {
    return { x: round9(dot.x), y: round9(dot.y), radius: round9(dot.radius) };
  }

  function serializeCommand(command: InkCommand, options: SignatureInkOptions) {
    if (command.type === 'dot') {
      return { type: 'dot', dot: serializeDot(command.dot) };
    }
    const curve = command.curve;
    const flattened = flattenCurve(curve, options.maxWidth);
    return {
      type: 'curve',
      startPoint: serializePoint(curve.startPoint),
      control1: serializePoint(curve.control1),
      control2: serializePoint(curve.control2),
      endPoint: serializePoint(curve.endPoint),
      startWidth: round9(curve.startWidth),
      endWidth: round9(curve.endWidth),
      drawSteps: flattened.length,
      firstDot: flattened.length > 0 ? serializeDot(flattened[0]) : null,
      midDot:
        flattened.length > 0 ? serializeDot(flattened[Math.floor(flattened.length / 2)]) : null,
      lastDot: flattened.length > 0 ? serializeDot(flattened[flattened.length - 1]) : null,
    };
  }

  test('fixture file matches the defaults', () => {
    expect(golden.defaultOptions).toEqual(DEFAULT_INK_OPTIONS);
    expect(golden.fixtures.length).toBeGreaterThanOrEqual(6);
  });

  test.each(golden.fixtures.map((fixture) => [fixture.name, fixture] as const))(
    'committed vectors for %s match freshly computed output',
    (_name, fixture) => {
      const options: SignatureInkOptions = { ...DEFAULT_INK_OPTIONS, ...fixture.options };
      const builder = new StrokeBuilder(options);
      builder.begin();

      let acceptedCount = 0;
      const commands: ReturnType<typeof serializeCommand>[] = [];
      for (const p of fixture.points) {
        const { accepted, command } = builder.add(p);
        if (accepted) {
          acceptedCount += 1;
        }
        if (command) {
          commands.push(serializeCommand(command, options));
        }
      }

      expect(acceptedCount).toBe(fixture.acceptedCount);
      expect(commands).toEqual(fixture.commands);
    }
  );

  test('min-distance fixture actually exercises the filter', () => {
    const fixture = golden.fixtures.find((f) => f.name === 'min-distance-filtering');
    expect(fixture).toBeDefined();
    expect(fixture!.points.length).toBe(6);
    expect(fixture!.acceptedCount).toBe(3);
  });
});
