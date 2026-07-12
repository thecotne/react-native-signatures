#!/usr/bin/env node
/**
 * Regenerates test-fixtures/signature-golden.json from src/signatureMath.ts.
 *
 * The fixtures pin the signature ink algorithm: fixed (x, y, time) input
 * sequences and the widths / Bézier control points / rasterization plans they
 * must produce. src/__tests__/signatureMath.test.ts recomputes them on every
 * test run (drift guard), and the Swift / Kotlin ports are expected to
 * reproduce the same numbers.
 *
 * Run after intentionally changing the algorithm:
 *   node scripts/generate-golden-fixtures.cjs
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signature-golden-'));

try {
  execFileSync(
    'npx',
    [
      'tsc',
      path.join(projectRoot, 'src', 'signatureMath.ts'),
      '--outDir',
      tmpDir,
      '--module',
      'commonjs',
      '--target',
      'es2019',
      '--skipLibCheck',
    ],
    { cwd: projectRoot, stdio: 'inherit' },
  );

  const math = require(path.join(tmpDir, 'signatureMath.js'));
  const fixtures = buildFixtures(math);
  const outputPath = path.join(projectRoot, 'test-fixtures', 'signature-golden.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(fixtures, null, 2)}\n`);
  console.log(`Wrote ${fixtures.fixtures.length} fixtures to ${path.relative(projectRoot, outputPath)}`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function round9(value) {
  const rounded = Math.round(value * 1e9) / 1e9;
  return rounded === 0 ? 0 : rounded;
}

function serializePoint(point) {
  return { x: round9(point.x), y: round9(point.y) };
}

function serializeDot(dot) {
  return { x: round9(dot.x), y: round9(dot.y), radius: round9(dot.radius) };
}

function serializeCommand(math, command, options) {
  if (command.type === 'dot') {
    return { type: 'dot', dot: serializeDot(command.dot) };
  }
  const curve = command.curve;
  const flattened = math.flattenCurve(curve, options.maxWidth);
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
    midDot: flattened.length > 0 ? serializeDot(flattened[Math.floor(flattened.length / 2)]) : null,
    lastDot: flattened.length > 0 ? serializeDot(flattened[flattened.length - 1]) : null,
  };
}

function runFixture(math, { name, options, points }) {
  const resolvedOptions = { ...math.DEFAULT_INK_OPTIONS, ...options };
  const builder = new math.StrokeBuilder(resolvedOptions);
  builder.begin();
  let acceptedCount = 0;
  const commands = [];
  for (const point of points) {
    const { accepted, command } = builder.add(point);
    if (accepted) {
      acceptedCount += 1;
    }
    if (command) {
      commands.push(serializeCommand(math, command, resolvedOptions));
    }
  }
  return { name, options, points, acceptedCount, commands };
}

function buildFixtures(math) {
  const definitions = [
    {
      name: 'line-constant-velocity',
      options: {},
      points: [
        { x: 0, y: 0, time: 0 },
        { x: 10, y: 0, time: 100 },
        { x: 20, y: 0, time: 200 },
        { x: 30, y: 0, time: 300 },
      ],
    },
    {
      name: 'tap',
      options: {},
      points: [{ x: 42.5, y: 17.25, time: 1000 }],
    },
    {
      name: 'accelerating-diagonal',
      options: {},
      points: [
        { x: 0, y: 0, time: 0 },
        { x: 6, y: 3, time: 48 },
        { x: 14, y: 7, time: 80 },
        { x: 26, y: 13, time: 104 },
        { x: 44, y: 22, time: 120 },
        { x: 70, y: 35, time: 132 },
      ],
    },
    {
      name: 'zigzag-variable-speed',
      options: {},
      points: [
        { x: 12, y: 80, time: 10 },
        { x: 30, y: 20, time: 90 },
        { x: 48, y: 76, time: 130 },
        { x: 66, y: 24, time: 210 },
        { x: 84, y: 72, time: 226 },
        { x: 102, y: 30, time: 320 },
      ],
    },
    {
      name: 'min-distance-filtering',
      options: {},
      points: [
        { x: 0, y: 0, time: 0 },
        // Within the 5-unit minDistance of the previous accepted point — dropped.
        { x: 3, y: 4, time: 16 },
        { x: 5, y: 0, time: 20 },
        { x: 12, y: 0, time: 32 },
        // Exactly minDistance away from (12, 0) — still dropped (<=).
        { x: 17, y: 0, time: 48 },
        { x: 24, y: 6, time: 64 },
      ],
    },
    {
      name: 'custom-options-slow-arc',
      options: { minWidth: 1, maxWidth: 4, velocityFilterWeight: 0.5, minDistance: 2, dotSize: 2 },
      points: [
        { x: 20, y: 60, time: 0 },
        { x: 26, y: 48, time: 60 },
        { x: 36, y: 40, time: 140 },
        { x: 50, y: 38, time: 200 },
        { x: 64, y: 44, time: 290 },
        { x: 72, y: 56, time: 360 },
      ],
    },
  ];

  return {
    description:
      'Golden vectors for the signature ink algorithm (signature_pad port). ' +
      'Generated by scripts/generate-golden-fixtures.cjs — do not edit by hand. ' +
      'All numbers are rounded to 9 decimal places.',
    defaultOptions: math.DEFAULT_INK_OPTIONS,
    fixtures: definitions.map((definition) => runFixture(math, definition)),
  };
}
