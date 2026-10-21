import { describe, expect, it } from "vitest";
import {
  CIRCULARITY_MIN,
  CLOSE_DISTANCE_PX,
  DWELL_MAX_TRAVEL_PX,
  DWELL_MS,
  LINE_EPSILON_PX,
  ORTHOGONAL_MAX_DEG,
  ORTHOGONAL_MIN_DEG,
  circularityQuotient,
  directionAngleDeg,
  endpointGap,
  euclideanPerimeter,
  isDwellGesture,
  meanPerpendicularDistance,
  polygonCentroid,
  recognizeShape,
  shoelaceArea,
  snapOrthogonalPolygon,
} from "../../lib/whiteboard/shape-engine";
import { SAMPLE_STRIDE, type Point, type RawPoint } from "../../lib/whiteboard/types";

function hold(points: RawPoint[]): RawPoint[] {
  const last = points[points.length - 1];
  const held = points.slice();
  for (const delay of [150, 300, 450, 500]) {
    held.push({ x: last.x, y: last.y, time: last.time + delay });
  }
  return held;
}

function withTime(points: Point[], step = 12): RawPoint[] {
  return points.map((point, index) => ({ x: point.x, y: point.y, time: index * step }));
}

function linePoints(d: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 15, y: d },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
}

function along(from: Point, to: Point, step: number): Point[] {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  const count = Math.max(1, Math.round(length / step));
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    points.push({
      x: from.x + (to.x - from.x) * t,
      y: from.y + (to.y - from.y) * t,
    });
  }
  return points;
}

function ring(vertices: Point[], step = 6): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < vertices.length; i++) {
    points.push(...along(vertices[i], vertices[(i + 1) % vertices.length], step));
  }
  return points;
}

function circleSamples(cx: number, cy: number, radius: number, count: number): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    points.push({
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  }
  return points;
}

function cornerAngle(vertices: Point[], index: number): number {
  const n = vertices.length;
  const prev = vertices[(index - 1 + n) % n];
  const cur = vertices[index];
  const next = vertices[(index + 1) % n];
  return directionAngleDeg(cur.x - prev.x, cur.y - prev.y, next.x - cur.x, next.y - cur.y);
}

function pack(points: RawPoint[]): Float32Array {
  const buffer = new Float32Array(points.length * SAMPLE_STRIDE);
  points.forEach((point, index) => {
    buffer[index * SAMPLE_STRIDE] = point.x;
    buffer[index * SAMPLE_STRIDE + 1] = point.y;
    buffer[index * SAMPLE_STRIDE + 2] = point.time;
  });
  return buffer;
}

describe("contract thresholds", () => {
  it("locks the geometric constants from the recognition spec", () => {
    expect(DWELL_MS).toBe(450);
    expect(DWELL_MAX_TRAVEL_PX).toBe(5);
    expect(LINE_EPSILON_PX).toBe(3.5);
    expect(CLOSE_DISTANCE_PX).toBe(15);
    expect(CIRCULARITY_MIN).toBe(0.82);
    expect(ORTHOGONAL_MIN_DEG).toBe(82);
    expect(ORTHOGONAL_MAX_DEG).toBe(98);
  });
});

describe("dwell", () => {
  it("accepts 4px of travel held for exactly 450ms", () => {
    const samples: RawPoint[] = [
      { x: 0, y: 0, time: 0 },
      { x: 4, y: 0, time: 450 },
    ];
    expect(isDwellGesture(samples)).toBe(true);
  });

  it("rejects the same travel when the window is 449ms", () => {
    const samples: RawPoint[] = [
      { x: 0, y: 0, time: 0 },
      { x: 4, y: 0, time: 449 },
    ];
    expect(isDwellGesture(samples)).toBe(false);
  });

  it("rejects 5px of travel even when the pause is long", () => {
    const samples: RawPoint[] = [
      { x: 0, y: 0, time: 0 },
      { x: 5, y: 0, time: 800 },
    ];
    expect(isDwellGesture(samples)).toBe(false);
  });

  it("accepts a long stroke once the pen has been still for 450ms", () => {
    const drawing = withTime(
      [
        { x: 0, y: 0 },
        { x: 40, y: 0 },
        { x: 80, y: 5 },
        { x: 120, y: 0 },
      ],
      40
    );
    expect(isDwellGesture(drawing)).toBe(false);
    expect(isDwellGesture(hold(drawing))).toBe(true);
  });

  it("does not treat a 400ms pause after fast ink as a dwell", () => {
    const samples: RawPoint[] = [
      { x: 0, y: 0, time: 0 },
      { x: 80, y: 0, time: 40 },
      { x: 80, y: 0, time: 440 },
    ];
    expect(isDwellGesture(samples)).toBe(false);
  });
});

describe("line regression", () => {
  it("measures a known horizontal residual of 8d/25", () => {
    const below = linePoints(10.875);
    const atEpsilon = linePoints(10.9375);
    expect(meanPerpendicularDistance(below)).toBeCloseTo(3.48, 10);
    expect(meanPerpendicularDistance(atEpsilon)).toBeCloseTo(3.5, 10);
  });

  it("is zero on a vertical stroke, where y-on-x regression would be undefined", () => {
    const vertical: Point[] = [
      { x: 4, y: 0 },
      { x: 4, y: 25 },
      { x: 4, y: 70 },
    ];
    expect(meanPerpendicularDistance(vertical)).toBeLessThan(1e-9);
  });

  it("snaps an open stroke under 3.5px to the first and last samples", () => {
    const shape = recognizeShape(hold(withTime(linePoints(10.875))));
    expect(shape).toEqual({
      type: "line",
      start: { x: 0, y: 0 },
      end: { x: 30, y: 0 },
    });
  });

  it("leaves an open stroke at exactly 3.5px as freehand", () => {
    const shape = recognizeShape(hold(withTime(linePoints(10.9375))));
    expect(shape.type).toBe("freehand");
  });

  it("does not snap a clean line until the pen dwells", () => {
    const shape = recognizeShape(withTime(linePoints(0)));
    expect(shape.type).toBe("freehand");
  });
});

describe("closed-path circularity", () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];

  it("computes the unit square as area 1, perimeter 4, centroid (0.5, 0.5)", () => {
    expect(shoelaceArea(square)).toBeCloseTo(1, 12);
    expect(euclideanPerimeter(square, true)).toBeCloseTo(4, 12);
    expect(polygonCentroid(square)).toEqual({ x: 0.5, y: 0.5 });
    expect(circularityQuotient(square)).toBeCloseTo(Math.PI / 4, 12);
    expect(circularityQuotient(square)).toBeLessThan(CIRCULARITY_MIN);
  });

  it("closes at 15px and stays open at 15.01px", () => {
    expect(endpointGap([{ x: 0, y: 0 }, { x: 15, y: 0 }])).toBe(15);
    expect(endpointGap([{ x: 0, y: 0 }, { x: 15.01, y: 0 }])).toBeCloseTo(15.01, 12);
  });

  it("snaps a sampled circle to radius L/2π about the polygonal centroid", () => {
    const drawn = circleSamples(80, 60, 48, 64);
    const shape = recognizeShape(hold(withTime(drawn, 8)));
    expect(shape.type).toBe("circle");
    if (shape.type !== "circle") return;

    const perimeter = euclideanPerimeter(drawn, true);
    const center = polygonCentroid(drawn);
    expect(shape.radius).toBeCloseTo(perimeter / (2 * Math.PI), 8);
    expect(shape.center.x).toBeCloseTo(center.x, 8);
    expect(shape.center.y).toBeCloseTo(center.y, 8);
    expect(shape.center.x).toBeCloseTo(80, 6);
    expect(shape.center.y).toBeCloseTo(60, 6);
    expect(circularityQuotient(drawn)).toBeGreaterThanOrEqual(CIRCULARITY_MIN);
  });

  it("does not close a stroke whose endpoints are 16px apart", () => {
    const arc: Point[] = [];
    for (let i = 0; i <= 24; i++) {
      const angle = (i / 24) * Math.PI * 1.25;
      arc.push({ x: 100 + 70 * Math.cos(angle), y: 100 + 70 * Math.sin(angle) });
    }
    expect(endpointGap(arc)).toBeGreaterThan(CLOSE_DISTANCE_PX);
    const shape = recognizeShape(hold(withTime(arc)));
    expect(shape.type).toBe("freehand");
  });
});

describe("orthogonal polygons", () => {
  function wedge(degrees: number): Point[] {
    const radians = (degrees * Math.PI) / 180;
    return [
      { x: -100, y: 0 },
      { x: 0, y: 0 },
      { x: 100 * Math.cos(radians), y: 100 * Math.sin(radians) },
    ];
  }

  it.each([82, 90, 98])("forces a %i° corner to exactly 90°", (degrees) => {
    const snapped = snapOrthogonalPolygon(wedge(degrees));
    expect(cornerAngle(snapped, 1)).toBeCloseTo(90, 8);
  });

  it.each([81.9, 98.1])("preserves a %i° corner outside the orthogonal band", (degrees) => {
    const original = wedge(degrees);
    const snapped = snapOrthogonalPolygon(original);
    expect(snapped[2]).toEqual(original[2]);
    expect(cornerAngle(snapped, 1)).toBeCloseTo(degrees, 6);
  });

  it("rebuilds a skewed quad of near-right corners as a rectangle", () => {
    const radians = (85 * Math.PI) / 180;
    const a = { x: 0, y: 0 };
    const b = { x: 100, y: 0 };
    const d = { x: 70 * Math.cos(radians), y: 70 * Math.sin(radians) };
    const c = { x: b.x + d.x, y: b.y + d.y };
    const snapped = snapOrthogonalPolygon([a, b, c, d]);
    expect(snapped).toHaveLength(4);
    for (let i = 0; i < 4; i++) {
      expect(cornerAngle(snapped, i)).toBeCloseTo(90, 8);
    }
    const width = Math.hypot(snapped[1].x - snapped[0].x, snapped[1].y - snapped[0].y);
    const height = Math.hypot(snapped[2].x - snapped[1].x, snapped[2].y - snapped[1].y);
    expect(width).toBeCloseTo(100, 8);
    expect(height).toBeCloseTo(70, 8);
  });

  it("recognizes a pen-drawn square as a four-corner orthogonal polygon", () => {
    const square = ring([
      { x: 20, y: 30 },
      { x: 140, y: 30 },
      { x: 140, y: 150 },
      { x: 20, y: 150 },
    ]);
    const shape = recognizeShape(hold(withTime(square)));
    expect(shape.type).toBe("polygon");
    if (shape.type !== "polygon") return;
    expect(shape.vertices).toHaveLength(4);
    for (let i = 0; i < shape.vertices.length; i++) {
      expect(cornerAngle(shape.vertices, i)).toBeCloseTo(90, 6);
    }
  });

  it("snaps only the near-right corner of a pen-drawn triangle", () => {
    const radians = (86 * Math.PI) / 180;
    const a = { x: 40, y: 50 };
    const b = { x: 190, y: 50 };
    const c = { x: 40 + 90 * Math.cos(radians), y: 50 + 90 * Math.sin(radians) };
    const shape = recognizeShape(hold(withTime(ring([a, b, c], 5))));
    expect(shape.type).toBe("polygon");
    if (shape.type !== "polygon") return;
    expect(shape.vertices).toHaveLength(3);

    const right = shape.vertices.reduce((best, vertex) =>
      Math.hypot(vertex.x - a.x, vertex.y - a.y) < Math.hypot(best.x - a.x, best.y - a.y)
        ? vertex
        : best
    );
    const index = shape.vertices.indexOf(right);
    expect(cornerAngle(shape.vertices, index)).toBeCloseTo(90, 6);

    const others = shape.vertices.filter((_, vertexIndex) => vertexIndex !== index);
    for (const vertex of others) {
      const angle = cornerAngle(shape.vertices, shape.vertices.indexOf(vertex));
      expect(angle).toBeGreaterThan(ORTHOGONAL_MAX_DEG);
    }
  });

  it("keeps an equilateral triangle from being forced to right angles", () => {
    const side = 140;
    const height = (Math.sqrt(3) / 2) * side;
    const triangle = ring([
      { x: 30, y: 180 },
      { x: 30 + side, y: 180 },
      { x: 30 + side / 2, y: 180 - height },
    ]);
    const shape = recognizeShape(hold(withTime(triangle)));
    expect(shape.type).toBe("polygon");
    if (shape.type !== "polygon") return;
    expect(shape.vertices).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(cornerAngle(shape.vertices, i)).toBeGreaterThan(100);
    }
  });
});

describe("ellipse and parabola", () => {
  function ellipseSamples(cx: number, cy: number, radiusX: number, radiusY: number, count: number): Point[] {
    const points: Point[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      points.push({
        x: cx + radiusX * Math.cos(angle),
        y: cy + radiusY * Math.sin(angle),
      });
    }
    return points;
  }

  function parabolaSamples(): Point[] {
    const points: Point[] = [];
    for (let x = 20; x <= 220; x += 4) {
      const dx = x - 120;
      points.push({ x, y: 40 + dx * dx * 0.01 });
    }
    return points;
  }

  it("recognizes a closed elongated oval as an ellipse", () => {
    const drawn = ellipseSamples(200, 200, 100, 35, 72);
    const shape = recognizeShape(hold(withTime(drawn, 8)));
    expect(shape.type).toBe("ellipse");
    if (shape.type !== "ellipse") return;
    expect(shape.center.x).toBeCloseTo(200, 0);
    expect(shape.center.y).toBeCloseTo(200, 0);
    expect(shape.radiusX).toBeGreaterThan(shape.radiusY);
    expect(shape.radiusX).toBeCloseTo(100, 0);
    expect(shape.radiusY).toBeCloseTo(35, 0);
  });

  it("recognizes a smooth open bow as a parabola", () => {
    const drawn = parabolaSamples();
    const shape = recognizeShape(hold(withTime(drawn, 8)));
    expect(shape.type).toBe("parabola");
    if (shape.type !== "parabola") return;
    expect(shape.vertex.x).toBeCloseTo(120, 0);
    expect(shape.vertex.y).toBeCloseTo(40, 0);
    expect(shape.start.x).toBe(20);
    expect(shape.end.x).toBe(220);
  });

  it("leaves a sharp V as freehand", () => {
    const drawn = [
      ...along({ x: 20, y: 20 }, { x: 120, y: 160 }, 6),
      ...along({ x: 120, y: 160 }, { x: 220, y: 20 }, 6),
    ];
    const shape = recognizeShape(hold(withTime(drawn, 8)));
    expect(shape.type).toBe("freehand");
  });
});

describe("packed samples", () => {
  it("recognizes a Float32Array history the same way as RawPoint objects", () => {
    const points = hold(
      withTime([
        { x: 2, y: 3 },
        { x: 20, y: 21 },
        { x: 40, y: 41 },
      ])
    );
    const fromObjects = recognizeShape(points);
    const fromBuffer = recognizeShape(pack(points));
    expect(fromBuffer).toEqual(fromObjects);
    expect(fromBuffer).toEqual({
      type: "line",
      start: { x: 2, y: 3 },
      end: { x: 40, y: 41 },
    });
  });
});
