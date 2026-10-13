/**
 * The discrete-event simulation kernel.
 *
 * It owns the clock, the event queue, routing between nodes, randomness and
 * metrics — and knows nothing about services, caches or load balancers. Those
 * are `NodeBehavior`s looked up by kind, which keeps the determinism-critical
 * machinery small enough to reason about and lets component semantics (U3) and
 * new presets (R2) land without touching it.
 *
 * Discrete-event rather than fixed timestep: events (arrival, service end,
 * timeout, mutation) sit on a priority queue over a sim clock, so the clock
 * jumps between things that actually happen. A fixed timestep would alias
 * queueing statistics near saturation — exactly the regime the whole tool
 * exists to report on — and would still need this same event log for replay.
 *
 * One engine, two drivers. `advance()` is what the render loop calls with a
 * wall-clock delta scaled by playback rate; `runUntil()` is what sweeps, tests
 * and replay call to drain flat out. They share every line of the code that
 * produces numbers, which is why a run watched live and the same run replayed
 * headless agree exactly rather than approximately.
 *
 * Two ways for work to move between nodes, because real architectures use both:
 *
 *   `forward` is a hand-off. The sending node is done; a load balancer routing a
 *   request, or a producer dropping a message on a queue.
 *
 *   `call` is request/response. The caller keeps holding whatever it was holding
 *   — its thread, its connection — until the callee settles, and is told whether
 *   the call succeeded. Without this, a service sitting upstream of a saturated
 *   datastore would read as perfectly healthy while its pool exhausted in
 *   reality, and "the DB got slow and the API fell over" is the single most
 *   common argument this tool exists to settle. A call mints a *child* job, so
 *   the caller can abandon one attempt and issue another while the abandoned
 *   work is still in flight downstream — which is what makes retry
 *   amplification (R6) emerge instead of being staged.
 */
import { createClock } from "./clock.ts";
import { EventPriority, createEventQueue, type EventPriorityValue } from "./events.ts";
import { createMetrics, type BucketSample, type InstantLevels } from "./metrics.ts";
import { createSubstreamSource, type Substream } from "./prng.ts";
import {
  callKey,
  checkMutation,
  loadDuration,
  validateTimeline,
  type LiveMutation,
  type LoadSegment,
  type TrafficSource,
  type MutationEvent,
  type NodeSnapshot,
  type Timeline,
} from "./timeline.ts";

export type { BucketSample } from "./metrics.ts";
export type { LiveMutation, ModelSnapshot, MutationEvent, NodeSnapshot, Timeline } from "./timeline.ts";

/** One unit of work moving through the model: a request, or one attempt at one. */
export interface Job {
  readonly id: number;
  /** Sim time the *originating* request was admitted. Children and retries
   *  inherit it, so end-to-end latency reflects what the caller waited rather
   *  than how long the last attempt took. */
  readonly createdAt: number;
  /** 0 for a first attempt, 1 for the first retry, and so on. */
  readonly attempt: number;
  /** True once this job has finished or been dropped. */
  readonly settled: boolean;
}

export type CallOutcome = "ok" | "dropped";

/** A call in progress. The caller holds this to give up on the attempt. */
export interface CallHandle {
  /**
   * Stop waiting for this call. The work already downstream is *not* cancelled —
   * it keeps consuming capacity and its eventual result is discarded. That waste
   * is the mechanism behind a retry storm, not an oversight.
   */
  abandon(): void;
  /** True once the call has returned or been abandoned. */
  readonly closed: boolean;
}

interface CallRecord {
  readonly callerNode: string;
  readonly onSettle: (outcome: CallOutcome) => void;
  abandoned: boolean;
  closed: boolean;
}

interface InternalJob {
  readonly id: number;
  readonly createdAt: number;
  readonly attempt: number;
  settled: boolean;
  /** Root jobs are the ones offered load created; they carry system accounting. */
  readonly isRoot: boolean;
  /**
   * The traffic source that made this job, for other traffic; `null` for the
   * modelled path. Kept off the system totals — a checkout and somebody else's
   * Redis GET are not two samples of one latency.
   */
  readonly source: string | null;
  /** Who is waiting on this job, if anyone. */
  call: CallRecord | null;
  currentNode: string | null;
  enteredNodeAt: number;
}

/**
 * One thing a node calls and waits for.
 *
 * `policy` is the call's timeout and retry, opaque to the engine. A `set-call`
 * mutation replaces the whole entry rather than editing it, so a behavior can
 * tell a changed policy from an unchanged one by identity alone.
 */
export interface Dependency {
  readonly id: string;
  readonly times: number;
  readonly policy: Record<string, unknown>;
}

/** What a behavior is handed. Every side effect a component can have lives here. */
export interface NodeContext {
  readonly id: string;
  now(): number;
  /** The node's current declarative spec, reflecting any mutation applied so far. */
  spec(): Record<string, unknown>;
  /** Where this node hands work on. Forward edges only, in model order. */
  downstream(): readonly string[];
  /**
   * What this node calls and waits for, and how many times per request.
   *
   * Separate from `downstream` because they are different relationships: one is
   * where the work goes next, the other is something asked along the way. A
   * component may lean on several dependencies and still have exactly one
   * successor, which is what lets a shared Redis be drawn once and called from
   * everywhere instead of being folded into each caller's own service time.
   */
  dependencies(): readonly Dependency[];
  /** This node's independent random stream for one purpose (see prng.ts). */
  random(purpose: string): Substream;
  /** Run `fn` after `delay` sim seconds. The only way for a behavior to use time. */
  schedule(delay: number, fn: () => void): void;

  /** Hand the job on and stop holding it. Immediate in sim time. */
  forward(nodeId: string, job: Job): void;
  /**
   * Send a child of `job` downstream and be told how it went. The caller keeps
   * holding `job` — and therefore whatever resource it occupies — until then.
   * `attempt` labels the child so priority disciplines and metrics can tell a
   * retry from a first try.
   */
  call(nodeId: string, job: Job, onSettle: (outcome: CallOutcome) => void, attempt?: number): CallHandle;
  /** This node is done with the job: settle the caller, or the system. */
  finish(job: Job): void;
  /** The job was shed, refused, or given up on here. */
  drop(job: Job, reason: string): void;
  /**
   * Re-admit this work as a fresh request through the entry node — an end-to-end
   * client retry, as opposed to a component retrying its own downstream call.
   */
  reissue(job: Job, delay: number): void;

  /** Jobs waiting here, not counting those in service. Painted by the live view. */
  setQueueDepth(depth: number): void;
  /** Servers currently busy, and optionally how many exist. Drives utilization. */
  setBusy(busy: number, servers?: number): void;
  /** Another node's current queue depth — what a least-loaded balancer routes on. */
  queueDepthOf(nodeId: string): number;
  recordTimeout(): void;
  recordRetry(): void;
}

export interface NodeBehavior {
  accept(job: Job, ctx: NodeContext): void;
  /** Called after a `set-spec` mutation lands on this node. */
  onSpecChange?(ctx: NodeContext): void;
}

export type BehaviorFactory = (node: NodeSnapshot) => NodeBehavior;
export type BehaviorRegistry = Record<string, BehaviorFactory>;

export interface SimSnapshot {
  time: number;
  inFlight: number;
  nodes: Record<string, InstantLevels>;
  /** The most recently closed metrics window, or `undefined` before the first. */
  latest: BucketSample | undefined;
}

export interface Simulation {
  now(): number;
  /** Drain every event up to `simTime`, then park the clock there. */
  runUntil(simTime: number): void;
  /** Advance by `delta` sim seconds. What the render loop calls. */
  advance(delta: number): void;
  series(): readonly BucketSample[];
  snapshot(): SimSnapshot;
  /** Sim time the offered load covers. Arrivals stop after it; draining continues. */
  duration(): number;
  /** True when nothing is left to happen — no work in flight, no load to come. */
  done(): boolean;
  /**
   * Apply an operator's change now, and append it to the recorded log (R7).
   *
   * The live-editing path. It takes effect in the running simulation — no stop,
   * edit and rerun — and because it goes into the same log a replay reads from,
   * the session stays reproducible afterwards. Throws rather than silently
   * skipping a change it cannot apply.
   */
  record(mutation: LiveMutation): void;
  /**
   * The timeline as recorded so far.
   *
   * Feed this to a fresh `createSimulation` and the session reruns exactly, live
   * tweaks included. This is what makes AE3 true of a demo rather than only of a
   * scripted run.
   */
  recorded(): Timeline;
  /** Introspection: a node's random stream, for tests and the validation harness. */
  substream(nodeId: string, purpose: string): Substream;
  drawCount(nodeId: string, purpose: string): number;
}

const DEFAULT_BUCKET_WIDTH = 1;

/** Shared by every call edge with nothing authored on it. */
const NO_POLICY: Record<string, unknown> = Object.freeze({});

export function createSimulation(timeline: Timeline, registry: BehaviorRegistry): Simulation {
  const validation = validateTimeline(timeline);
  if (!validation.ok) {
    throw new Error(`this timeline cannot be run:\n  ${validation.errors.join("\n  ")}`);
  }

  const clock = createClock(0);
  const queue = createEventQueue();
  const random = createSubstreamSource(timeline.seed);
  const nodeIds = timeline.model.nodes.map((node) => node.id);
  const metrics = createMetrics(nodeIds, () => clock.now());
  const bucketWidth = timeline.bucketWidth ?? DEFAULT_BUCKET_WIDTH;
  const arrivalProcess = timeline.arrivalProcess ?? "poisson";
  const entryId = timeline.model.entryId;

  const specs = new Map<string, Record<string, unknown>>();
  const downstream = new Map<string, string[]>();
  const dependencies = new Map<string, Dependency[]>();
  for (const node of timeline.model.nodes) {
    specs.set(node.id, { ...node.spec });
    downstream.set(node.id, []);
    dependencies.set(node.id, []);
  }
  for (const edge of timeline.model.edges) {
    if (edge.kind === "call") {
      dependencies.get(edge.from)?.push({ id: edge.to, times: edge.times ?? 1, policy: edge.policy ?? NO_POLICY });
    } else {
      downstream.get(edge.from)?.push(edge.to);
    }
  }

  const behaviors = new Map<string, NodeBehavior>();
  for (const node of timeline.model.nodes) {
    const factory = registry[node.kind];
    if (factory === undefined) {
      throw new Error(
        `node "${node.id}" has kind "${node.kind}", which no behavior is registered for. ` +
          `Known kinds: ${Object.keys(registry).join(", ") || "(none)"}`,
      );
    }
    behaviors.set(node.id, factory(node));
  }

  // Events that are not metrics boundaries. `done()` reads this rather than the
  // queue length, because bucket closes reschedule themselves forever and would
  // otherwise make a finished simulation look busy.
  let pendingWork = 0;
  let nextJobId = 1;

  function schedule(time: number, priority: EventPriorityValue, fn: () => void): void {
    if (priority !== EventPriority.BUCKET) pendingWork += 1;
    queue.push(time, priority, () => {
      if (priority !== EventPriority.BUCKET) pendingWork -= 1;
      fn();
    });
  }

  function newJob(
    createdAt: number,
    attempt: number,
    isRoot: boolean,
    source: string | null = null,
  ): InternalJob {
    const job: InternalJob = {
      id: nextJobId,
      createdAt,
      attempt,
      settled: false,
      isRoot,
      source,
      call: null,
      currentNode: null,
      enteredNodeAt: clock.now(),
    };
    nextJobId += 1;
    return job;
  }

  // ---------------------------------------------------------------- routing

  function deliver(nodeId: string, job: InternalJob): void {
    const behavior = behaviors.get(nodeId);
    if (behavior === undefined) {
      throw new Error(`job ${job.id} was routed to "${nodeId}", which is not a node in this model`);
    }
    metrics.nodeArrival(nodeId);
    metrics.adjustResident(nodeId, 1);
    job.currentNode = nodeId;
    job.enteredNodeAt = clock.now();
    behavior.accept(job, contexts.get(nodeId) as NodeContext);
  }

  function leave(job: InternalJob): void {
    const nodeId = job.currentNode;
    if (nodeId === null) {
      throw new Error(`job ${job.id} left a node it was not in — a behavior settled it twice`);
    }
    metrics.nodeDeparture(nodeId, clock.now() - job.enteredNodeAt);
    metrics.adjustResident(nodeId, -1);
    job.currentNode = null;
  }

  /**
   * Close out a job: tell whoever was waiting, or close the books on the request.
   *
   * A job whose caller has already given up settles into nothing. That is the
   * wasted work of a retry storm — capacity spent on a result no one will read.
   */
  function settle(job: InternalJob, outcome: CallOutcome): void {
    job.settled = true;
    const record = job.call;
    if (record !== null) {
      if (record.closed) return;
      record.closed = true;
      if (!record.abandoned) record.onSettle(outcome);
      return;
    }
    if (job.source !== null) {
      if (outcome === "ok") metrics.sourceCompletion(job.source);
      else metrics.sourceDrop(job.source);
      return;
    }
    if (!job.isRoot) return;
    if (outcome === "ok") {
      metrics.systemCompletion(clock.now() - job.createdAt);
    } else {
      metrics.systemDrop();
    }
  }

  function admit(job: InternalJob): void {
    metrics.systemArrival();
    if (entryId === null) {
      // A model with no entry admits nothing; the job is accounted for and gone.
      job.settled = true;
      metrics.systemDrop();
      return;
    }
    deliver(entryId, job);
  }

  // ---------------------------------------------------------------- contexts

  const contexts = new Map<string, NodeContext>();
  for (const node of timeline.model.nodes) {
    const id = node.id;
    contexts.set(id, {
      id,
      now: () => clock.now(),
      spec: () => specs.get(id) as Record<string, unknown>,
      downstream: () => downstream.get(id) as string[],
      dependencies: () => dependencies.get(id) as Dependency[],
      random: (purpose) => random.stream(id, purpose),

      schedule(delay, fn) {
        if (!(delay >= 0)) {
          throw new Error(`node "${id}" scheduled work at a negative delay (${delay})`);
        }
        schedule(clock.now() + delay, EventPriority.SERVICE, fn);
      },

      forward(nodeId, job) {
        const internal = job as InternalJob;
        if (!downstream.has(nodeId)) {
          throw new Error(`node "${id}" forwarded to "${nodeId}", which is not a node in this model`);
        }
        leave(internal);
        // Immediate in sim time: an edge is a wire, not a delay. Anything that
        // should cost time belongs to a node's service, where it is visible.
        deliver(nodeId, internal);
      },

      call(nodeId, job, onSettle, attempt = 0) {
        if (!downstream.has(nodeId)) {
          throw new Error(`node "${id}" called "${nodeId}", which is not a node in this model`);
        }
        const record: CallRecord = { callerNode: id, onSettle, abandoned: false, closed: false };
        const child = newJob(job.createdAt, attempt, false);
        child.call = record;
        deliver(nodeId, child);
        return {
          abandon() {
            if (record.closed) return;
            record.abandoned = true;
          },
          get closed() {
            return record.closed || record.abandoned;
          },
        };
      },

      finish(job) {
        const internal = job as InternalJob;
        if (internal.settled) throw new Error(`job ${job.id} was finished twice`);
        leave(internal);
        settle(internal, "ok");
      },

      drop(job, reason) {
        const internal = job as InternalJob;
        if (internal.settled) throw new Error(`job ${job.id} was settled twice (drop: ${reason})`);
        metrics.nodeDrop(id);
        leave(internal);
        settle(internal, "dropped");
      },

      reissue(job, delay) {
        const retry = newJob(job.createdAt, job.attempt + 1, true);
        schedule(clock.now() + delay, EventPriority.ARRIVAL, () => admit(retry));
      },

      setQueueDepth: (depth) => metrics.setQueueDepth(id, depth),
      setBusy: (busy, servers) => metrics.setBusy(id, busy, servers),
      queueDepthOf: (nodeId) => metrics.levels()[nodeId]?.queueDepth ?? 0,
      recordTimeout: () => metrics.nodeTimeout(id),
      recordRetry: () => metrics.nodeRetry(id),
    });
  }

  // ---------------------------------------------------------------- arrivals

  let segments: readonly LoadSegment[] = timeline.load;
  let segmentIndex = 0;
  let segmentStart = 0;
  // Bumped whenever the load is replaced, so the arrival already on the queue
  // under the old schedule is ignored rather than hunted down and cancelled.
  let loadGeneration = 0;

  function scheduleNextArrival(): void {
    const generation = loadGeneration;
    let from = clock.now();

    for (;;) {
      let segment = segments[segmentIndex];
      while (segment !== undefined && from >= segmentStart + segment.duration) {
        segmentStart += segment.duration;
        segmentIndex += 1;
        segment = segments[segmentIndex];
      }
      if (segment === undefined) return; // offered load exhausted

      const segmentEnd = segmentStart + segment.duration;
      if (segment.rate === 0) {
        from = segmentEnd;
        continue;
      }

      const gap =
        arrivalProcess === "poisson"
          ? random.stream("__load__", "arrival").nextExponential(segment.rate)
          : 1 / segment.rate;
      const at = from + gap;

      // A gap that overshoots the segment is discarded at the boundary and
      // redrawn under the next segment's rate. The exponential is memoryless,
      // so restarting it costs nothing statistically and keeps each segment an
      // exact homogeneous Poisson process — which is what the M/M/1 checks need.
      if (at >= segmentEnd) {
        from = segmentEnd;
        continue;
      }

      schedule(at, EventPriority.ARRIVAL, () => {
        if (generation !== loadGeneration) return;
        admit(newJob(clock.now(), 0, true));
        scheduleNextArrival();
      });
      return;
    }
  }

  // ---------------------------------------------------------------- mutations

  function scheduleMutation(mutation: MutationEvent): void {
    schedule(mutation.at, EventPriority.MUTATION, () => {
      if (mutation.kind === "set-spec") {
        specs.set(mutation.nodeId, { ...mutation.spec });
        behaviors.get(mutation.nodeId)?.onSpecChange?.(contexts.get(mutation.nodeId) as NodeContext);
      } else if (mutation.kind === "set-call") {
        // Read at the next decision each call makes, so an attempt already in
        // flight finishes under the policy it started with and the one after it
        // obeys the new one — the same rule `set-spec` follows.
        const list = dependencies.get(mutation.from);
        const index = list?.findIndex((dependency) => dependency.id === mutation.to) ?? -1;
        if (list === undefined || index < 0) return;
        list[index] = { ...(list[index] as Dependency), policy: { ...mutation.policy } };
      } else if (mutation.kind === "set-load") {
        segments = mutation.segments;
        segmentIndex = 0;
        segmentStart = clock.now();
        loadGeneration += 1;
        scheduleNextArrival();
      } else {
        const source = sourceList.find((candidate) => candidate.id === mutation.sourceId);
        if (source === undefined) return;
        sourceRates.set(source.id, mutation.rate);
        sourceGenerations.set(source.id, (sourceGenerations.get(source.id) as number) + 1);
        scheduleNextSourceArrival(source);
      }
    });
  }

  // The recorded log: what was handed in, plus whatever the operator does live.
  const recordedMutations: MutationEvent[] = [...timeline.mutations];
  const nodeIdSet = new Set(nodeIds);
  const sourceIdSet = new Set((timeline.model.sources ?? []).map((source) => source.id));
  const callKeySet = new Set(
    timeline.model.edges.filter((edge) => edge.kind === "call").map((edge) => callKey(edge.from, edge.to)),
  );

  for (const mutation of timeline.mutations) scheduleMutation(mutation);

  // ---------------------------------------------------------------- buckets

  function scheduleNextBucket(at: number): void {
    schedule(at, EventPriority.BUCKET, () => {
      metrics.closeBucket(at);
      scheduleNextBucket(at + bucketWidth);
    });
  }

  // ---------------------------------------------------------- other traffic

  const totalLoad = loadDuration(timeline.load);
  const sourceList = timeline.model.sources ?? [];
  const sourceRates = new Map<string, number>();
  // One generation per source, for the same reason the offered load has one: a
  // rate turned down mid-run leaves an arrival already on the queue under the
  // old rate, and ignoring it is cheaper than hunting it down.
  const sourceGenerations = new Map<string, number>();
  for (const source of sourceList) {
    sourceRates.set(source.id, source.rate);
    sourceGenerations.set(source.id, 0);
  }

  /**
   * Other traffic runs for exactly as long as the offered load does.
   *
   * Not a schedule of its own: a source states a level, and a level with no end
   * would leave `done()` false forever because there would always be one more
   * arrival on the queue. A batch job that starts halfway through is the live
   * knob's business, and it is recorded like every other live change.
   */
  function scheduleNextSourceArrival(source: TrafficSource): void {
    const generation = sourceGenerations.get(source.id) as number;
    const rate = sourceRates.get(source.id) as number;
    if (rate <= 0) return;

    const gap =
      arrivalProcess === "poisson"
        ? // Its own substream, keyed by the source, so adding other traffic —
          // or changing its rate — does not move a single arrival of the
          // modelled path. Turning the spine's neighbours on and off then
          // changes contention and nothing else about the load realisation.
          random.stream("__traffic__", source.id).nextExponential(rate)
        : 1 / rate;
    const at = clock.now() + gap;
    if (at >= totalLoad) return;

    schedule(at, EventPriority.ARRIVAL, () => {
      if (generation !== sourceGenerations.get(source.id)) return;
      const job = newJob(clock.now(), 0, false, source.id);
      metrics.sourceArrival(source.id);
      deliver(source.nodeId, job);
      scheduleNextSourceArrival(source);
    });
  }

  scheduleNextBucket(bucketWidth);
  scheduleNextArrival();
  for (const source of sourceList) scheduleNextSourceArrival(source);

  function runUntil(target: number): void {
    if (target < clock.now()) {
      throw new Error(
        `simulation cannot run backwards: asked to run until ${target} while at ${clock.now()}`,
      );
    }

    for (;;) {
      const next = queue.peekTime();
      if (next === undefined || next > target) break;
      const event = queue.pop();
      if (event === undefined) break;
      // The clock only ever moves to an event's own time, never to whatever
      // moment a driver happened to ask for mid-frame. Metrics integrate off
      // this clock, so the paced and headless series are identical rather than
      // merely close: the same additions, in the same order, whoever is
      // turning the handle.
      clock.set(event.time);
      event.run();
    }

    clock.set(target);
  }

  return {
    now: () => clock.now(),
    runUntil,
    advance: (delta) => runUntil(clock.now() + delta),
    series: () => metrics.series(),
    duration: () => totalLoad,
    done: () => pendingWork === 0,
    substream: (nodeId, purpose) => random.stream(nodeId, purpose),
    drawCount: (nodeId, purpose) => random.drawCount(nodeId, purpose),

    record(mutation) {
      // Stamped with the clock's current value, which after any `runUntil` is
      // exactly the target it was asked for — so the stamp is a real sim time and
      // not an artefact of where a frame happened to land mid-event.
      const event = { ...mutation, at: clock.now() } as MutationEvent;
      const previous = recordedMutations[recordedMutations.length - 1]?.at ?? Number.NEGATIVE_INFINITY;
      const errors = checkMutation(event, nodeIdSet, previous, "this change", sourceIdSet, callKeySet);
      if (errors.length > 0) {
        throw new Error(`that change cannot be applied:\n  ${errors.join("\n  ")}`);
      }

      recordedMutations.push(event);
      scheduleMutation(event);
    },

    recorded: () => ({ ...timeline, mutations: [...recordedMutations] }),

    snapshot: () => {
      const series = metrics.series();
      return {
        time: clock.now(),
        inFlight: metrics.inFlight(),
        nodes: metrics.levels(),
        latest: series[series.length - 1],
      };
    },
  };
}
