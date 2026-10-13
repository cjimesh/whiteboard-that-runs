/**
 * The pure view model: simulation state in, everything the renderer needs out.
 *
 * The split matters for one reason. The renderer paints and decides nothing, so
 * every judgement the screen makes — which component looks like it is folding,
 * how thick a flow ribbon is, what the legend claims — is a value in this file,
 * derived by a pure function and testable without a canvas. A renderer that
 * decided things itself would put the tool's claims somewhere no test could
 * reach, and the claims are the product.
 *
 * Rates are averaged over a trailing sim-time window rather than read from the
 * newest metrics bucket. A single bucket at a low arrival rate holds a handful of
 * completions, so a gauge driven off it flickers between plausible and absurd,
 * and a room reads flicker as the model being unreliable. The window is sim time,
 * not wall time, so the smoothing is part of the deterministic record too.
 */
import type { BucketSample, SourceBucket } from "../engine/metrics.ts";
import type { SimSnapshot } from "../engine/kernel.ts";
import type { EdgeKind, ModelSnapshot } from "../engine/timeline.ts";
import { resolveSpec, type ComponentKind, type PartialComponentSpec } from "../specs/format.ts";
import { LAYOUT_BOX, layoutModel, type Box, type Placement } from "./layout.ts";

/**
 * How a component is reading right now, as a *visual* signal only.
 *
 * Not the verdict. "Breaks" in the product's sense means intrinsic instability
 * measured over a sustained window by the sweep (U7), and that is a different,
 * slower judgement than what a gauge can show in one frame. These three states
 * exist so the room's eye lands on the right component within a second; the
 * breaking-point readout is what they should argue about.
 */
export type Health = "ok" | "strain" | "fold";

/**
 * Why a component is in trouble: because of itself, or because of something it
 * is waiting on.
 *
 * `origin` is the one that started it. `carrier` is folding because something
 * downstream of it is — a service whose threads are all held waiting on a
 * saturated datastore is a symptom, not a cause.
 *
 * This distinction exists because the screen without it is actively misleading.
 * Trouble propagates *backwards* through a call-and-wait graph, so one bad
 * component reddens everything in front of it, and the picture accuses the
 * innocent along with the guilty. A user of this build spent three rounds
 * working out which of four red boxes was the cause; the model had been right
 * the whole time and the picture was not explaining it.
 */
export type FoldRole = "origin" | "carrier";

export interface NodeFrame {
  id: string;
  label: string;
  kind: ComponentKind;
  place: Placement;
  /** Set only while `health` is `fold`. */
  role: FoldRole | null;
  /** 0 to 1, busy servers over declared servers. */
  utilization: number;
  queueDepth: number;
  capacity: number;
  /** Queue depth against capacity, 0 to 1. Clamped, so an unbounded queue reads low. */
  queueFill: number;
  concurrency: number;
  /** Mean time spent in this component, seconds. */
  latency: number;
  /** Departures per second over the window. */
  throughput: number;
  /** Drops per second over the window. */
  dropRate: number;
  /** Retries this component issued, per second over the window. */
  retryRate: number;
  /**
   * The load somebody else's traffic is putting on this component right now.
   *
   * `null` where none is stated. On screen it is the difference between a spine
   * that reads 70% busy for no visible reason and one whose picture says why —
   * the requests are real, they are in `throughput` and `utilization`, and they
   * arrive along no wire the canvas can draw.
   */
  otherTraffic: OtherTrafficFrame | null;
  health: Health;
}

export interface OtherTrafficFrame {
  /** Requests per second offered by every source landing here. */
  offered: number;
  /** How many of those the component turned away, per second. */
  turnedAway: number;
  /** Stub thickness in layout units, on the same scale as the wires. */
  width: number;
}

export interface EdgeFrame {
  from: string;
  to: string;
  /**
   * Whether this wire is where work goes next or something the sender leans on.
   *
   * The renderer has to be able to tell them apart, because they are different
   * claims about the system and a picture that drew them alike would be the
   * canvas asserting a chain that is not there.
   */
  kind: EdgeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Requests per second crossing this edge, approximated by the target's arrivals. */
  throughput: number;
  /** Ribbon thickness in layout units. */
  width: number;
  /**
   * Where a wire that would cross a box detours instead: the height of a lane
   * run above or below everything in its way. Absent on a wire with a clear path.
   */
  lane?: number;
}

export interface SystemFrame {
  /** Requests per second the model was asked to serve. */
  offered: number;
  /** Requests per second that actually completed for somebody. */
  goodput: number;
  dropRate: number;
  latencyP95: number;
  inFlight: number;
}

export type LegendSwatch = "utilization" | "queue" | "ribbon" | "drops" | "retries" | "cache" | "other-traffic";

export interface LegendItem {
  swatch: LegendSwatch;
  /** The thing on screen. */
  term: string;
  /** The quantity it stands for. */
  meaning: string;
}

/**
 * The component that folded first, and what is downstream of the blame.
 *
 * A live judgement, and deliberately a narrower claim than U7's sweep makes: it
 * names the origin of the trouble *on screen now*, where the sweep reports the
 * load a design holds to. Both answer "who folds first"; this one answers it
 * about the run in front of you.
 */
export interface Culprit {
  id: string;
  /** Plain-language cause, in this component's own numbers. */
  reason: string;
  /** Components folding because of this one, nearest first. */
  carrying: string[];
}

export interface Frame {
  time: number;
  box: Box;
  nodes: NodeFrame[];
  edges: EdgeFrame[];
  system: SystemFrame;
  legend: LegendItem[];
  /** `null` when nothing is folding. */
  culprit: Culprit | null;
}

/** A point in layout units. */
export interface Point {
  x: number;
  y: number;
}

/** One cubic Bézier piece of a wire: start, two control points, end. */
export type WireSegment = readonly [Point, Point, Point, Point];

/** How far a detour runs out of its sender, and into its receiver, before turning. */
const DETOUR_REACH = 28;
/** Room left between a detour's lane and the boxes it passes. */
const DETOUR_CLEARANCE = 18;
/** Distance between detours that share a side, so they do not draw as one. */
const LANE_SPACING = 12;

/**
 * The path a wire is drawn along, from its sender to `endX`.
 *
 * One function, used to draw a wire, to highlight it, to hit-test it and to
 * decide whether it needs a detour, so those four cannot disagree about where
 * the wire is. `endX` stops short of the receiver to leave room for an arrowhead.
 *
 * Either way the wire leaves its sender heading right and enters its receiver
 * heading right, so the arrowhead always points right.
 */
export function wireSegments(edge: Pick<EdgeFrame, "x1" | "y1" | "x2" | "y2" | "lane">, endX = edge.x2): WireSegment[] {
  const { x1, y1, y2 } = edge;
  if (edge.lane === undefined) {
    // A flat S-curve rather than a straight line: with fan-out, straight edges to
    // stacked targets converge into an unreadable star at the source.
    const midX = (x1 + endX) / 2;
    return [[{ x: x1, y: y1 }, { x: midX, y: y1 }, { x: midX, y: y2 }, { x: endX, y: y2 }]];
  }
  const lane = edge.lane;
  // A dense model leaves narrow gaps between columns; the turns shrink to fit.
  const reach = edge.x2 > x1 ? Math.min(DETOUR_REACH, (edge.x2 - x1) / 2) : DETOUR_REACH;
  const out = x1 + reach;
  const into = edge.x2 - reach;
  const turnOut = (x1 + out) / 2;
  const turnIn = (into + endX) / 2;
  return [
    [{ x: x1, y: y1 }, { x: turnOut, y: y1 }, { x: turnOut, y: lane }, { x: out, y: lane }],
    [{ x: out, y: lane }, { x: out + (into - out) / 3, y: lane }, { x: out + (2 * (into - out)) / 3, y: lane }, { x: into, y: lane }],
    [{ x: into, y: lane }, { x: turnIn, y: lane }, { x: turnIn, y: y2 }, { x: endX, y: y2 }],
  ];
}

function pointOnSegment([p0, p1, p2, p3]: WireSegment, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** Points along a wire from sender to receiver, `perSegment` to each piece. */
export function sampleWire(edge: Pick<EdgeFrame, "x1" | "y1" | "x2" | "y2" | "lane">, perSegment = 24): Point[] {
  const points: Point[] = [];
  for (const segment of wireSegments(edge)) {
    for (let i = points.length === 0 ? 0 : 1; i <= perSegment; i += 1) points.push(pointOnSegment(segment, i / perSegment));
  }
  return points;
}

/** The middle of a wire as drawn — where a click lands on it. */
export function wireMidpoint(edge: Pick<EdgeFrame, "x1" | "y1" | "x2" | "y2" | "lane">): Point {
  const points = sampleWire(edge);
  return points[Math.floor(points.length / 2)] as Point;
}

function inside(point: Point, place: Placement): boolean {
  return point.x > place.x && point.x < place.x + place.w && point.y > place.y && point.y < place.y + place.h;
}

/**
 * Give every wire that would be drawn through a box a lane round it.
 *
 * Layering puts each component one column right of whatever sends to it, so a
 * wire that skips a column — a service calling a database two columns over —
 * ran straight behind the box between and read as that box's wire. A wire that
 * runs right-to-left (a loop back) went through its own sender. Both get a lane
 * above or below everything in the columns they span, on whichever side is
 * nearer; lanes on the same side are stacked so two detours stay two lines.
 */
function routeAround(edges: EdgeFrame[], nodes: readonly NodeFrame[], box: Box): EdgeFrame[] {
  const used = { above: 0, below: 0 };
  return edges.map((edge) => {
    const leftward = edge.x2 <= edge.x1;
    const others = nodes.filter((node) => node.id !== edge.from && node.id !== edge.to && node.place.w > 0);
    const crosses = sampleWire(edge).some((point) => others.some((node) => inside(point, node.place)));
    if (!leftward && !crosses) return edge;

    // Everything under the lane's run. A leftward wire runs back over its own
    // two ends, so they are in the way too.
    const lo = Math.min(edge.x1, edge.x2) - (leftward ? DETOUR_REACH : 0);
    const hi = Math.max(edge.x1, edge.x2) + (leftward ? DETOUR_REACH : 0);
    const inTheWay = nodes
      .filter((node) => node.place.w > 0 && node.place.x < hi && node.place.x + node.place.w > lo)
      .filter((node) => leftward || (node.id !== edge.from && node.id !== edge.to))
      .map((node) => node.place);
    if (inTheWay.length === 0) return edge;

    const top = Math.min(...inTheWay.map((place) => place.y));
    const bottom = Math.max(...inTheWay.map((place) => place.y + place.h));
    const middle = (edge.y1 + edge.y2) / 2;
    const side = middle - top <= bottom - middle ? "above" : "below";
    const offset = DETOUR_CLEARANCE + used[side] * LANE_SPACING;
    used[side] += 1;
    const lane = side === "above" ? Math.max(4, top - offset) : Math.min(box.height - 4, bottom + offset);
    return { ...edge, lane };
  });
}

export interface FrameInput {
  model: ModelSnapshot;
  snapshot: SimSnapshot;
  series: readonly BucketSample[];
  /** Trailing sim-time window to average rates over. Seconds. */
  window?: number;
  box?: Box;
}

const DEFAULT_WINDOW = 1.5;
/** Ribbon thickness at a rate that fills the widest ribbon drawn. */
const RIBBON_REFERENCE_RATE = 200;
const RIBBON_WIDTH = { min: 1.5, max: 22 };

/**
 * Ribbon thickness for a rate, in layout units.
 *
 * Square root, not linear: a 20× range of rates has to stay readable at both
 * ends, and linear scaling makes everything below the busiest wire look like
 * nothing is happening. Shared by the wires and by the stub other traffic
 * arrives on, so a spine's two kinds of inbound load compare by eye.
 */
function ribbonWidth(throughput: number): number {
  return (
    RIBBON_WIDTH.min + (RIBBON_WIDTH.max - RIBBON_WIDTH.min) * Math.sqrt(clamp01(throughput / RIBBON_REFERENCE_RATE))
  );
}

/** Buckets whose end falls inside the trailing window. */
function windowOf(series: readonly BucketSample[], time: number, window: number): readonly BucketSample[] {
  const from = time - window;
  const inWindow = series.filter((bucket) => bucket.end > from);
  // Before the first window has elapsed there may be nothing yet; fall back to
  // the most recent bucket so early frames show real numbers rather than zeros.
  if (inWindow.length > 0) return inWindow;
  const last = series[series.length - 1];
  return last === undefined ? [] : [last];
}

function secondsCovered(buckets: readonly BucketSample[]): number {
  if (buckets.length === 0) return 0;
  const first = buckets[0] as BucketSample;
  const last = buckets[buckets.length - 1] as BucketSample;
  return Math.max(last.end - first.start, Number.EPSILON);
}

function healthOf(utilization: number, queueFill: number, dropRate: number): Health {
  // Full utilization on its own is *not* folding, and getting this wrong makes the
  // canvas worse rather than merely inaccurate. A server pinned at 100% with a
  // short queue is keeping up — it is being used efficiently. Treating saturation
  // as failure painted every busy component red during the demo spiral, including
  // the two application replicas that were coping fine, which buried the one
  // component actually in trouble in a screen of red.
  //
  // So red means work is being lost or the buffer is filling: not keeping up.
  // Amber means working hard. Whether a queue is *diverging* under sustained load
  // is a slower judgement than one frame can make, and belongs to the sweep (U7).
  if (dropRate > 0 || queueFill >= 0.6) return "fold";
  if (utilization >= 0.85 || queueFill >= 0.2) return "strain";
  return "ok";
}

/**
 * Which folding component is the cause, and which are downstream of the blame.
 *
 * The rule is causal and follows the wiring: **a folding component with another
 * folding component behind it is a carrier, not an origin.** In a call-and-wait
 * graph a caller holds its server while the callee answers, so a saturated
 * datastore drags its callers down with it — the caller's red is borrowed.
 *
 * Ties and cycles are settled by depth (longest path from a source), so the
 * deepest folding component wins. A cycle where everything folds has no node
 * without a folding successor, and would otherwise name nobody.
 *
 * Two components failing independently is a real possibility this reports
 * imperfectly: it names the deeper one and lists the other as carrying. That is
 * a known limit of a one-frame judgement, and it is what U7's sweep exists to
 * settle properly by taking the load apart.
 */
function attributeFolding(model: ModelSnapshot, nodes: NodeFrame[]): Culprit | null {
  const folding = nodes.filter((node) => node.health === "fold");
  if (folding.length === 0) return null;

  const foldingIds = new Set(folding.map((node) => node.id));
  const downstream = new Map<string, string[]>();
  for (const node of model.nodes) downstream.set(node.id, []);
  for (const edge of model.edges) downstream.get(edge.from)?.push(edge.to);

  const depth = nodeDepths(model);
  const deepestFirst = [...folding].sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0));

  const origin =
    deepestFirst.find((node) => !(downstream.get(node.id) ?? []).some((id) => foldingIds.has(id))) ??
    deepestFirst[0];
  if (origin === undefined) return null;

  for (const node of folding) node.role = node.id === origin.id ? "origin" : "carrier";

  return {
    id: origin.id,
    reason: reasonFor(origin),
    carrying: folding
      .filter((node) => node.id !== origin.id)
      .sort((a, b) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0))
      .map((node) => node.id),
  };
}

/**
 * Longest path from any source. Same measure the layout ranks columns by.
 *
 * Exported because the sweep attributes a fold the same way this does, and the
 * rule — a component in trouble with another in trouble behind it is a carrier —
 * only means anything if both use the same idea of "behind".
 */
export function nodeDepths(model: ModelSnapshot): Map<string, number> {
  const depths = new Map<string, number>();
  for (const node of model.nodes) depths.set(node.id, 0);

  for (let pass = 0; pass < model.nodes.length; pass += 1) {
    let moved = false;
    for (const edge of model.edges) {
      const from = depths.get(edge.from);
      const to = depths.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (to < from + 1) {
        depths.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return depths;
}

/** The cause in this component's own numbers, so the claim can be checked. */
function reasonFor(node: NodeFrame): string {
  const losing = `losing ${node.dropRate >= 10 ? Math.round(node.dropRate) : node.dropRate.toFixed(1)}/s`;
  const full = node.queueFill >= 0.6;
  const saturated = node.utilization >= 0.95;

  if (node.dropRate > 0 && full) {
    return `its queue is full and it is ${losing}`;
  }
  if (node.dropRate > 0) {
    return saturated ? `it is at capacity and ${losing}` : `it is ${losing}`;
  }
  return saturated ? "it is at capacity and its queue is filling" : "its queue is filling";
}

function legendFor(model: ModelSnapshot, nodes: NodeFrame[]): LegendItem[] {
  // Only encodings this model actually uses. A legend explaining retry storms to
  // someone looking at a model with no retries teaches them to see something
  // that is not there.
  const items: LegendItem[] = [
    {
      swatch: "utilization",
      term: "Fill",
      meaning: "How much of a component's capacity is in use. Full means it cannot go faster.",
    },
    {
      swatch: "queue",
      term: "Bar",
      meaning: "Work waiting, against how much is allowed to wait.",
    },
    {
      swatch: "ribbon",
      term: "Ribbon",
      meaning: "Requests per second crossing a wire. Thicker is more.",
    },
  ];

  if ((model.sources ?? []).length > 0) {
    items.push({
      swatch: "other-traffic",
      term: "Stub",
      meaning:
        "Traffic from outside this drawing, landing on a shared component. It takes up room there and goes no further.",
    });
  }

  if (nodes.some((node) => Number.isFinite(node.capacity))) {
    items.push({
      swatch: "drops",
      term: "Ticks",
      // Two things produce a drop, and the legend said only one of them. A service
      // that exhausts its retries kills the request itself, with an empty buffer —
      // which is exactly what the demo's application tier does at the worst moment,
      // so the narrower wording was wrong precisely where it mattered most.
      meaning: "Work thrown away: a buffer was full, or a component gave up on a call.",
    });
  }

  const anyRetries = model.nodes.some((node) => {
    if (node.kind !== "service") return false;
    return resolveSpec("service", node.spec as PartialComponentSpec).retry.policy !== "none";
  });
  if (anyRetries) {
    items.push({
      swatch: "retries",
      term: "Retry count",
      meaning:
        "Attempts a component reissued after a timeout. Each one is extra load its downstream sees.",
    });
  }

  if (model.nodes.some((node) => node.kind === "cache")) {
    items.push({
      swatch: "cache",
      term: "Hit ratio",
      meaning: "A stated share of requests served without reaching the origin — an input, not a measurement.",
    });
  }

  return items;
}

/**
 * The picture with no run behind it: what the editor draws.
 *
 * Every metric is zero because nothing has happened yet, which is honest — the
 * editor is showing a design, not a measurement. It goes through the same
 * `Frame` and the same renderer as a running model so the thing an author wires
 * up is visibly the thing that runs, rather than two drawings that drift.
 */
export function emptyFrame(model: ModelSnapshot, box: Box = LAYOUT_BOX): Frame {
  const layout = layoutModel(model, box);

  // Stated other traffic, not measured other traffic. It belongs here for the
  // same reason capacity and concurrency do: it is a number the author gave,
  // and the editor's job is to show the design they described.
  const statedTraffic = new Map<string, number>();
  for (const source of model.sources ?? []) {
    statedTraffic.set(source.nodeId, (statedTraffic.get(source.nodeId) ?? 0) + source.rate);
  }

  const nodes: NodeFrame[] = model.nodes.map((node) => {
    const kind = node.kind as ComponentKind;
    const spec = resolveSpec(kind, node.spec as PartialComponentSpec);
    return {
      id: node.id,
      label: node.id,
      kind,
      place: layout.nodes[node.id] ?? { x: 0, y: 0, w: 0, h: 0 },
      utilization: 0,
      queueDepth: 0,
      capacity: kind === "balancer" ? Number.POSITIVE_INFINITY : spec.queue.capacity,
      queueFill: 0,
      concurrency: kind === "balancer" ? 0 : spec.concurrency,
      latency: 0,
      throughput: 0,
      dropRate: 0,
      retryRate: 0,
      otherTraffic: statedTraffic.has(node.id)
        ? {
            offered: statedTraffic.get(node.id) as number,
            turnedAway: 0,
            width: ribbonWidth(statedTraffic.get(node.id) as number),
          }
        : null,
      health: "ok",
      role: null,
    };
  });

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges: EdgeFrame[] = model.edges.map((edge) => {
    const a = byId.get(edge.from)?.place ?? { x: 0, y: 0, w: 0, h: 0 };
    const b = byId.get(edge.to)?.place ?? { x: 0, y: 0, w: 0, h: 0 };
    return {
      from: edge.from,
      to: edge.to,
      kind: edge.kind ?? "forward",
      x1: a.x + a.w,
      y1: a.y + a.h / 2,
      x2: b.x,
      y2: b.y + b.h / 2,
      throughput: 0,
      width: RIBBON_WIDTH.min,
    };
  });

  return {
    time: 0,
    box,
    nodes,
    edges: routeAround(edges, nodes, box),
    system: { offered: 0, goodput: 0, dropRate: 0, latencyP95: 0, inFlight: 0 },
    legend: legendFor(model, nodes),
    culprit: null,
  };
}

export function frameFor(input: FrameInput): Frame {
  const { model, snapshot, series } = input;
  const box = input.box ?? LAYOUT_BOX;
  const window = input.window ?? DEFAULT_WINDOW;
  const layout = layoutModel(model, box);

  const buckets = windowOf(series, snapshot.time, window);
  const seconds = secondsCovered(buckets);
  const rate = (total: number): number => (seconds === 0 ? 0 : total / seconds);

  const sumNode = (id: string, pick: (bucket: BucketSample) => number): number =>
    buckets.reduce((total, bucket) => total + (bucket.nodes[id] === undefined ? 0 : pick(bucket)), 0);

  const sourcesByNode = new Map<string, string[]>();
  for (const source of model.sources ?? []) {
    const list = sourcesByNode.get(source.nodeId);
    if (list === undefined) sourcesByNode.set(source.nodeId, [source.id]);
    else list.push(source.id);
  }

  const otherTrafficAt = (nodeId: string): OtherTrafficFrame | null => {
    const ids = sourcesByNode.get(nodeId);
    if (ids === undefined) return null;
    const sum = (pick: (entry: SourceBucket) => number): number =>
      buckets.reduce(
        (total, bucket) =>
          total + ids.reduce((each, id) => each + (bucket.sources[id] === undefined ? 0 : pick(bucket.sources[id] as SourceBucket)), 0),
        0,
      );
    const offered = rate(sum((entry) => entry.arrivals));
    return { offered, turnedAway: rate(sum((entry) => entry.drops)), width: ribbonWidth(offered) };
  };

  const nodes: NodeFrame[] = model.nodes.map((node) => {
    const kind = node.kind as ComponentKind;
    const spec = resolveSpec(kind, node.spec as PartialComponentSpec);
    const levels = snapshot.nodes[node.id];
    const place = layout.nodes[node.id] ?? { x: 0, y: 0, w: 0, h: 0 };

    const departures = sumNode(node.id, (bucket) => bucket.nodes[node.id]?.departures ?? 0);
    const sojournTotal = buckets.reduce((total, bucket) => {
      const entry = bucket.nodes[node.id];
      return entry === undefined ? total : total + entry.sojournMean * entry.departures;
    }, 0);

    const capacity = kind === "balancer" ? Number.POSITIVE_INFINITY : spec.queue.capacity;
    const queueDepth = levels?.queueDepth ?? 0;
    const utilization = clamp01(sumNode(node.id, (bucket) => bucket.nodes[node.id]?.utilization ?? 0) / buckets.length);
    const dropRate = rate(sumNode(node.id, (bucket) => bucket.nodes[node.id]?.drops ?? 0));
    const queueFill = Number.isFinite(capacity) && capacity > 0 ? clamp01(queueDepth / capacity) : 0;

    return {
      id: node.id,
      label: node.id,
      kind,
      place,
      utilization,
      queueDepth,
      capacity,
      queueFill,
      concurrency: kind === "balancer" ? 0 : spec.concurrency,
      latency: departures === 0 ? 0 : sojournTotal / departures,
      throughput: rate(departures),
      dropRate,
      retryRate: rate(sumNode(node.id, (bucket) => bucket.nodes[node.id]?.retries ?? 0)),
      otherTraffic: otherTrafficAt(node.id),
      health: healthOf(utilization, queueFill, dropRate),
      role: null,
    };
  });

  // Fills in each folding node's role as a side effect, so the roles and the
  // named culprit can never disagree about who started it.
  const culprit = attributeFolding(model, nodes);

  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edges: EdgeFrame[] = model.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    const a = from?.place ?? { x: 0, y: 0, w: 0, h: 0 };
    const b = to?.place ?? { x: 0, y: 0, w: 0, h: 0 };
    // On a hand-off, arrivals at the target stand in for flow along the wire.
    // Exact per-edge accounting would need the kernel to attribute arrivals to
    // the edge they came in on, which is more machinery than a ribbon's thickness
    // justifies, and a hand-off target usually has one inbound wire.
    //
    // A dependency is the case where that stops being true: five components
    // calling one Redis all share its arrivals, and drawing each wire at the
    // shared total would tell the room every caller was sending five times what
    // it sends. So a call is measured at its *source*, times the calls per
    // request — which is a number the author gave us.
    //
    // Other traffic breaks the hand-off shortcut the same way a dependency does,
    // and it is why the target's arrivals are netted off here: a shared spine's
    // arrivals include the load nobody drew, and charging that to the one wire
    // pointing at it would tell the room its sender is sending several times
    // what it sends. The stub below the box is where that load is drawn instead.
    // (A caller cannot have other traffic on it — the leaf rule sees to that —
    // so the `call` branch needs no such correction.)
    const kind = edge.kind ?? "forward";
    const throughput =
      kind === "call"
        ? rate(sumNode(edge.from, (bucket) => bucket.nodes[edge.from]?.arrivals ?? 0)) * (edge.times ?? 1)
        : Math.max(
            0,
            rate(sumNode(edge.to, (bucket) => bucket.nodes[edge.to]?.arrivals ?? 0)) -
              (to?.otherTraffic?.offered ?? 0),
          );

    return {
      from: edge.from,
      to: edge.to,
      kind,
      x1: a.x + a.w,
      y1: a.y + a.h / 2,
      x2: b.x,
      y2: b.y + b.h / 2,
      throughput,
      width: ribbonWidth(throughput),
    };
  });

  const systemTotals = buckets.reduce(
    (totals, bucket) => ({
      arrivals: totals.arrivals + bucket.system.arrivals,
      completions: totals.completions + bucket.system.completions,
      drops: totals.drops + bucket.system.drops,
    }),
    { arrivals: 0, completions: 0, drops: 0 },
  );

  return {
    time: snapshot.time,
    box,
    nodes,
    edges: routeAround(edges, nodes, box),
    system: {
      offered: rate(systemTotals.arrivals),
      goodput: rate(systemTotals.completions),
      dropRate: rate(systemTotals.drops),
      latencyP95: buckets[buckets.length - 1]?.system.latencyP95 ?? 0,
      inFlight: snapshot.inFlight,
    },
    legend: legendFor(model, nodes),
    culprit,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
