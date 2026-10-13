/**
 * Canvas 2D renderer. Paints a frame and decides nothing.
 *
 * Every quantity drawn here was settled by `frame.ts`, which is what keeps the
 * tool's claims testable without comparing pixels: this file cannot invent an
 * emphasis the frame did not derive from the simulation.
 *
 * The gauges are chosen for one audience — people who did not build the model,
 * reading a shared screen from across a room (R8). That rules out anything that
 * needs a hover, a legend lookup, or a number read carefully. What is left is
 * position, area and colour: a fill that rises, a bar that grows, a border that
 * turns red, ribbons that thicken. Numbers are printed as well, but nothing
 * depends on reading them.
 */
import { sampleWire, wireSegments, type EdgeFrame, type Frame, type Health, type NodeFrame, type Point } from "./frame.ts";
import type { Box } from "./layout.ts";

const COLORS = {
  background: "#0b0e14",
  surface: "#141922",
  border: "#232b39",
  text: "#dfe5f0",
  muted: "#8894ab",
  ribbon: "rgba(76,194,255,0.22)",
  ok: "#4ade80",
  strain: "#fbbf24",
  fold: "#f87171",
  queue: "rgba(76,194,255,0.85)",
  otherTraffic: "rgba(148,163,184,0.85)",
  accent: "#4cc2ff",
} as const;

const HEALTH_COLOR: Record<Health, string> = {
  ok: COLORS.ok,
  strain: COLORS.strain,
  fold: COLORS.fold,
};

/** Short kind labels. Spelled out rather than iconic — a glyph needs a legend. */
const KIND_LABEL: Record<string, string> = {
  service: "service",
  queue: "queue",
  balancer: "balancer",
  cache: "cache",
  datastore: "datastore",
};

/**
 * What the screen adds on top of a frame: what is selected, what is wrong, what
 * to call things. Never a claim about the simulation — those come from the frame
 * alone — so a decoration can be wrong about emphasis but never about a number.
 */
export interface Decorations {
  selectedNode?: string | null;
  selectedEdge?: { from: string; to: string } | null;
  /** The first problem with each component, by id, badged on its box. */
  problems?: ReadonlyMap<string, string>;
  /**
   * What to print under a component's name, where the author's word for it —
   * "Database", "In-memory store" — says more than the engine's kind.
   */
  kindLabels?: ReadonlyMap<string, string>;
  /** Components whose core numbers are all still guesses nobody confirmed. */
  assumed?: ReadonlySet<string>;
  /** A connection being dragged out of a box, in layout units. */
  dragLine?: { x1: number; y1: number; x2: number; y2: number } | null;
}

export interface Renderer {
  paint(frame: Frame, decorations?: Decorations): void;
  /**
   * Which component is under a pointer event, or `null` for empty canvas.
   *
   * Lives with the renderer because it is the inverse of the transform the
   * renderer applies, and splitting the two would let a layout change break
   * clicking without breaking drawing.
   */
  nodeAt(event: { clientX: number; clientY: number }, frame: Frame): string | null;
  /** Which wire is under a pointer event, or `null`. Boxes win over wires. */
  edgeAt(event: { clientX: number; clientY: number }, frame: Frame): { from: string; to: string } | null;
  /** A pointer event in layout units, for drawing something that follows it. */
  toLayout(event: { clientX: number; clientY: number }, frame: Frame): { x: number; y: number };
  destroy(): void;
}

interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/** Fit the fixed logical box into the element, preserving aspect ratio. */
export function computeViewport(width: number, height: number, box: Box): Viewport {
  if (width <= 0 || height <= 0) return { scale: 1, offsetX: 0, offsetY: 0 };
  const scale = Math.min(width / box.width, height / box.height);
  return {
    scale,
    offsetX: (width - box.width * scale) / 2,
    offsetY: (height - box.height * scale) / 2,
  };
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function formatRate(value: number): string {
  if (value >= 100) return `${Math.round(value)}/s`;
  if (value >= 10) return `${value.toFixed(1)}/s`;
  return `${value.toFixed(2)}/s`;
}

function formatLatency(seconds: number): string {
  if (seconds <= 0) return "—";
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  return `${seconds.toFixed(2)} s`;
}

function distanceToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / length));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

/** How far from a wire still counts as on it: thin wires get a forgiving margin. */
export function edgeHitDistance(edge: EdgeFrame, x: number, y: number): number {
  const points = sampleWire(edge);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    best = Math.min(best, distanceToSegment(x, y, points[i - 1] as Point, points[i] as Point));
  }
  return best;
}

/**
 * The arrowhead's size for a ribbon this wide.
 *
 * Grows with the ribbon so it still reads as a point on the thickest wire, and
 * has a floor so the thinnest — every wire in the editor — still shows which
 * way it runs. Without one the first person to use the editor drew a wire the
 * wrong way round and the canvas could not show it.
 */
function headSize(width: number): { length: number; half: number } {
  return { length: 12 + width * 0.5, half: 7 + width * 0.5 };
}

/** Stroke a wire's path, stopping where its arrowhead starts. */
function traceWire(ctx: CanvasRenderingContext2D, edge: EdgeFrame, endX: number): void {
  const segments = wireSegments(edge, endX);
  ctx.beginPath();
  ctx.moveTo(segments[0]?.[0].x ?? edge.x1, segments[0]?.[0].y ?? edge.y1);
  for (const [, c1, c2, end] of segments) ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
  ctx.stroke();
}

/** A filled arrowhead with its point on the receiver's edge. Wires always arrive heading right. */
function fillHead(ctx: CanvasRenderingContext2D, edge: EdgeFrame, width: number): void {
  const { length, half } = headSize(width);
  ctx.beginPath();
  ctx.moveTo(edge.x2, edge.y2);
  ctx.lineTo(edge.x2 - length, edge.y2 - half);
  ctx.lineTo(edge.x2 - length, edge.y2 + half);
  ctx.closePath();
  ctx.fill();
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: EdgeFrame): void {
  // A dependency is drawn broken, because it is a different claim: work does not
  // travel along it and come out the other end, it goes and comes back. A room
  // reading a solid line assumes a chain.
  //
  // The dash scales with the ribbon. A fixed six-pixel dash disappeared entirely
  // on the wires that matter most — a heavily-called shared spine draws the
  // thickest ribbons on the canvas, so the gaps have to grow with them or the one
  // place the distinction is load-bearing is the one place it cannot be seen.
  const dash = Math.max(6, edge.width * 1.1);
  ctx.setLineDash(edge.kind === "call" ? [dash, dash * 0.85] : []);
  ctx.strokeStyle = COLORS.ribbon;
  ctx.lineWidth = edge.width;
  // Butt caps on a dependency: round caps at this scale close most of the gap
  // again, which is how the first attempt still looked solid.
  ctx.lineCap = edge.kind === "call" ? "butt" : "round";
  traceWire(ctx, edge, edge.x2 - headSize(edge.width).length);
  ctx.fillStyle = COLORS.ribbon;
  fillHead(ctx, edge, edge.width);
}

function drawNode(ctx: CanvasRenderingContext2D, node: NodeFrame, box: Box, decorations: Decorations): void {
  const { x, y, w, h } = node.place;
  if (w <= 0 || h <= 0) return;
  const accent = HEALTH_COLOR[node.health];

  ctx.fillStyle = COLORS.surface;
  roundRect(ctx, x, y, w, h, 10);
  ctx.fill();

  // Utilization as a fill rising from the bottom of the box. Area, not a number:
  // "that one is full" has to be readable at a glance and from a distance.
  const fillHeight = h * node.utilization;
  if (fillHeight > 0.5) {
    ctx.save();
    roundRect(ctx, x, y, w, h, 10);
    ctx.clip();
    ctx.globalAlpha = node.health === "ok" ? 0.18 : 0.38;
    ctx.fillStyle = accent;
    ctx.fillRect(x, y + h - fillHeight, w, fillHeight);
    ctx.restore();
  }

  ctx.strokeStyle = node.health === "ok" ? COLORS.border : accent;
  // The component that started the trouble is drawn heavier than the ones it
  // dragged down with it, so the eye lands on the cause rather than on whichever
  // red box happens to be nearest. A carrier's red is borrowed.
  ctx.lineWidth = node.health === "ok" ? 1 : node.role === "origin" ? 3.5 : 2;
  roundRect(ctx, x, y, w, h, 10);
  ctx.stroke();

  if (node.role === "origin") {
    ctx.fillStyle = COLORS.fold;
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText("FIRST TO FOLD", x, y - 9, w);
    ctx.textBaseline = "top";
  } else if (node.role === "carrier") {
    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillText("carrying", x, y - 9, w);
    ctx.textBaseline = "top";
  }

  const pad = 10;
  ctx.textBaseline = "top";
  ctx.fillStyle = COLORS.text;
  ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
  ctx.fillText(node.label, x + pad, y + pad, w - 2 * pad);

  ctx.fillStyle = COLORS.muted;
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
  const kind = decorations.kindLabels?.get(node.id) ?? KIND_LABEL[node.kind] ?? node.kind;
  const concurrency = node.concurrency > 0 ? ` ×${node.concurrency}` : "";
  // Said on the box, because the box is what the room reads: a number nobody has
  // confirmed is a guess, and the picture should not present it as a fact.
  const assumed = decorations.assumed?.has(node.id) === true ? " · assumed" : "";
  ctx.fillText(`${kind}${concurrency}${assumed}`, x + pad, y + pad + 19, w - 2 * pad);

  // Traffic from outside the drawing, arriving on a stub below the box. Below,
  // because every wire on this canvas runs left to right and a fourth ribbon
  // into a shared spine's left edge would read as a wire from a component
  // somebody forgot to draw. It has no source box on purpose: that is the claim.
  if (node.otherTraffic !== null && node.otherTraffic.offered > 0) {
    const traffic = node.otherTraffic;
    const midX = x + w / 2;
    const foot = y + h;
    // An arrowhead, and a stem longer than the stub is wide. The first version
    // was a plain 22-wide, 16-tall bar: at the widest ribbon scale that is very
    // nearly a square, and it read as a legend swatch parked under the box
    // rather than as traffic arriving. Direction is the whole point of the mark.
    const head = 9;
    const stem = 15;

    // Cleared explicitly: the last wire drawn may have been a dependency, and a
    // dash left on the context would make this stub look like one too.
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.otherTraffic;
    ctx.fillRect(midX - traffic.width / 2, foot + head, traffic.width, stem);
    ctx.beginPath();
    ctx.moveTo(midX, foot);
    ctx.lineTo(midX - Math.max(traffic.width, 7), foot + head);
    ctx.lineTo(midX + Math.max(traffic.width, 7), foot + head);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = COLORS.muted;
    ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const label =
      traffic.turnedAway > 0
        ? `${formatRate(traffic.offered)} other, ${formatRate(traffic.turnedAway)} turned away`
        : `${formatRate(traffic.offered)} other`;

    // Which side the label sits on is decided here rather than in the frame,
    // because it depends on how wide the text measures in this font — and the
    // rightmost box on the canvas is exactly where a shared spine tends to be,
    // so the first version ran "16.0/s turned aw…" off the edge of the picture.
    const gap = Math.max(traffic.width, 7) + 6;
    const fitsRight = midX + gap + ctx.measureText(label).width <= box.width - 4;
    ctx.textAlign = fitsRight ? "left" : "right";
    ctx.fillText(label, fitsRight ? midX + gap : midX - gap, foot + head + stem / 2);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }

  if (h < 74) return; // too small for readouts; the fill and border still carry

  const barY = y + h - pad - 20;
  const barW = w - 2 * pad;
  ctx.font = "11px ui-sans-serif, system-ui, sans-serif";

  if (node.kind === "balancer") {
    // No queue, no service time, nothing to be a bottleneck with. Showing an
    // empty queue readout here would invite the room to look for one.
    ctx.fillStyle = COLORS.muted;
    ctx.fillText(`${formatRate(node.throughput)} through`, x + pad, barY + 9, barW);
    return;
  }

  // Queue depth: a bar against its capacity, so "nearly full" is a length and
  // not a ratio the reader has to compute.
  ctx.fillStyle = COLORS.border;
  roundRect(ctx, x + pad, barY, barW, 5, 2.5);
  ctx.fill();
  if (node.queueFill > 0) {
    ctx.fillStyle = node.queueFill >= 0.6 ? accent : COLORS.queue;
    roundRect(ctx, x + pad, barY, Math.max(2, barW * node.queueFill), 5, 2.5);
    ctx.fill();
  }

  ctx.fillStyle = COLORS.muted;
  ctx.fillText(formatLatency(node.latency), x + pad, barY + 9, barW * 0.55);

  ctx.textAlign = "right";
  ctx.fillStyle = node.queueDepth > 0 ? COLORS.text : COLORS.muted;
  ctx.fillText(`${node.queueDepth} waiting`, x + w - pad, barY + 9, barW * 0.45);
  ctx.textAlign = "left";

  // Drop ticks along the top edge — a countable mark per unit of shed work, so
  // "it is losing requests" is visible without reading a rate.
  if (node.dropRate > 0) {
    const ticks = Math.min(12, Math.max(1, Math.round(node.dropRate / 5)));
    ctx.fillStyle = COLORS.fold;
    for (let i = 0; i < ticks; i += 1) {
      ctx.fillRect(x + pad + i * 7, y - 5, 4, 4);
    }
  }

  if (node.retryRate > 0) {
    ctx.fillStyle = COLORS.strain;
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`↻ ${formatRate(node.retryRate)}`, x + w - pad, y + pad + 19);
    ctx.textAlign = "left";
  }
}

function drawDecorations(ctx: CanvasRenderingContext2D, frame: Frame, decorations: Decorations): void {
  ctx.setLineDash([]);

  const selectedEdge = decorations.selectedEdge;
  if (selectedEdge != null) {
    const edge = frame.edges.find((candidate) => candidate.from === selectedEdge.from && candidate.to === selectedEdge.to);
    if (edge !== undefined) {
      ctx.strokeStyle = COLORS.accent;
      ctx.fillStyle = COLORS.accent;
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      const width = Math.max(edge.width, 2.5);
      traceWire(ctx, edge, edge.x2 - headSize(width).length);
      fillHead(ctx, edge, width);
    }
  }

  for (const node of frame.nodes) {
    const { x, y, w, h } = node.place;
    if (w <= 0 || h <= 0) continue;

    if (decorations.selectedNode === node.id) {
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 2;
      roundRect(ctx, x - 5, y - 5, w + 10, h + 10, 13);
      ctx.stroke();
    }

    // On the box, not in a list under the canvas: "nothing reaches this" means
    // something only next to the thing nothing reaches.
    if (decorations.problems?.has(node.id) === true) {
      const cx = x + w - 2;
      const cy = y + 2;
      ctx.fillStyle = COLORS.strain;
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.background;
      ctx.font = "700 12px ui-sans-serif, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("!", cx, cy + 0.5);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    }
  }

  const drag = decorations.dragLine;
  if (drag != null) {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    ctx.moveTo(drag.x1, drag.y1);
    ctx.lineTo(drag.x2, drag.y2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

export function renderFrame(ctx: CanvasRenderingContext2D, frame: Frame, decorations: Decorations = {}): void {
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, frame.box.width, frame.box.height);

  for (const edge of frame.edges) drawEdge(ctx, edge);
  ctx.setLineDash([]);
  for (const node of frame.nodes) drawNode(ctx, node, frame.box, decorations);
  drawDecorations(ctx, frame, decorations);
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas 2d context unavailable");

  const toLayout = (event: { clientX: number; clientY: number }, frame: Frame): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const { scale, offsetX, offsetY } = computeViewport(rect.width, rect.height, frame.box);
    return {
      x: (event.clientX - rect.left - offsetX) / (scale || 1),
      y: (event.clientY - rect.top - offsetY) / (scale || 1),
    };
  };

  return {
    paint(frame, decorations = {}) {
      const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
      const rect = canvas.getBoundingClientRect();
      const width = rect.width || frame.box.width;
      const height = rect.height || frame.box.height;

      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);

      const { scale, offsetX, offsetY } = computeViewport(width, height, frame.box);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Clear the whole element, not just the logical box, so letterboxing from
      // an odd aspect ratio does not leave a stale strip at the edges.
      ctx.fillStyle = COLORS.background;
      ctx.fillRect(0, 0, width, height);
      ctx.translate(offsetX, offsetY);
      ctx.scale(scale, scale);

      renderFrame(ctx, frame, decorations);
    },

    toLayout,

    edgeAt(event, frame) {
      if (this.nodeAt(event, frame) !== null) return null;
      const { x, y } = toLayout(event, frame);
      let best: { from: string; to: string } | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const edge of frame.edges) {
        const distance = edgeHitDistance(edge, x, y);
        if (distance <= Math.max(8, edge.width / 2 + 4) && distance < bestDistance) {
          best = { from: edge.from, to: edge.to };
          bestDistance = distance;
        }
      }
      return best;
    },

    nodeAt(event, frame) {
      const rect = canvas.getBoundingClientRect();
      const { scale } = computeViewport(rect.width, rect.height, frame.box);
      if (scale <= 0) return null;
      const { x, y } = toLayout(event, frame);

      // Last first: later nodes are painted over earlier ones, so the one on top
      // is the one a click means.
      for (let index = frame.nodes.length - 1; index >= 0; index -= 1) {
        const node = frame.nodes[index] as Frame["nodes"][number];
        const { place } = node;
        if (x >= place.x && x <= place.x + place.w && y >= place.y && y <= place.y + place.h) {
          return node.id;
        }
      }
      return null;
    },

    destroy() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    },
  };
}
