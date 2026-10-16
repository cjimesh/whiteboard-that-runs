/**
 * The demo system: a shape people recognise, tuned so the failure lands.
 *
 * A balancer, two application replicas, one database. Nothing exotic, and every
 * number in it is one a reviewer would nod at: 2 ms of application work, a 250 ms
 * timeout, three retries with backoff, a database that manages about fifty
 * requests a second. Nobody looking at these parameters would predict a collapse
 * at forty-four requests a second — which is the entire point. The spiral is a
 * consequence of the numbers, not a scenario written into them.
 *
 * The arc it exists to support (F3): boring and green at 30/s, dragged past
 * capacity, timeouts spawn retries, retries become load, throughput dies — then
 * one preset change caps the retries and it recovers, live, without a restart.
 *
 * U8 owns polishing this into the 60-second demo. What it needs to be now is a
 * real model that reaches the interesting state on its own.
 */
import type { PartialComponentSpec } from "../specs/format.ts";
import type { RunControls } from "./controls.ts";
import { addComponent, connect, emptyDocument, renameComponent, setLoad, type WhiteboardDocument } from "../model/document.ts";
import type { Timeline } from "../engine/timeline.ts";

/**
 * The two numbers the demo's story is about, named so the story can be derived
 * from them rather than written alongside them.
 *
 * The guidance shown to a first-time viewer says "the database manages about
 * fifty a second" and "calls give up after 250 ms". Both were prose once, and
 * prose about a model drifts the moment the model is tuned — which has already
 * happened here once, when the resting load stayed described as boring for a
 * whole build after it had stopped being boring.
 */
const API_TIMEOUT = 0.25;
const DB_SERVICE_MEAN = 0.02;
const DB_CONNECTIONS = 1;

/** Application tier. `retry` is the parameter the live control swaps. */
function apiSpec(retry: PartialComponentSpec["retry"]): PartialComponentSpec {
  return {
    concurrency: 200,
    service: { policy: "fixed", mean: 0.002 },
    queue: { policy: "fifo", capacity: 5_000 },
    timeout: { policy: "fixed", after: API_TIMEOUT },
    ...(retry === undefined ? {} : { retry }),
  };
}

/** The datastore: the thing at the end that is actually the limit. */
function dbSpec(): PartialComponentSpec {
  return {
    concurrency: DB_CONNECTIONS,
    service: { policy: "exponential", mean: DB_SERVICE_MEAN },
    queue: { policy: "fifo", capacity: 30 },
  };
}

export const RETRY_PRESETS = {
  backoff: { policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5 },
  capped: { policy: "capped", attempts: 1, delay: 0.2, factor: 2, maxDelay: 0.5 },
  budgeted: { policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5, budget: 0.1 },
  none: { policy: "none", attempts: 0, delay: 0.05, factor: 2, maxDelay: 1 },
} as const satisfies Record<string, NonNullable<PartialComponentSpec["retry"]>>;

/**
 * The resting load, and why it is not 30.
 *
 * It was 30/s, described as "boring and green". Measured, it is not: at 30/s the
 * model runs happily for about a minute and then collapses on its own, with
 * nobody touching a control. That is not a bug — it is metastability, and it is
 * the same mechanism as the demo's headline collapse. A rare burst pushes a few
 * database waits past the 250 ms timeout, each timeout becomes up to three
 * retries, the retries are new load, and past a point the loop sustains itself.
 * Time-to-collapse is a random variable, which is why it looked stable.
 *
 * Endurance runs to 400 sim seconds across three seeds: 22/s held every time,
 * 25/s died on one seed of three, 28/s died on all three inside 200 s, 30/s
 * inside 90 s. So the honest stable band for this design is **under half the
 * database's nominal 50/s**, and the resting load has to sit inside it or the
 * demo kills itself while its presenter is still talking.
 */
export const DEMO_BASE_RATE = 22;
export const DEMO_MAX_RATE = 90;

/**
 * The rate the tour asks a viewer to drag to.
 *
 * Not the highest rate available and not a round number: 44/s is under the
 * datastore's nominal capacity, which is the entire point of the demo. Nothing
 * in the model is over-provisioned at this load — the collapse is produced by
 * the retries, not by the arithmetic. `demo.test.ts` asserts that it does in
 * fact collapse here, so the tour cannot promise something the model stopped
 * doing.
 */
export const DEMO_COLLAPSE_RATE = 44;

/** Small windows so the live gauges move; still part of the recorded timeline. */
const LIVE_BUCKET_WIDTH = 0.25;

export function demoTimeline(): Timeline {
  return {
    model: {
      entryId: "gateway",
      nodes: [
        { id: "gateway", kind: "balancer", spec: { balancer: { policy: "round-robin" } } },
        { id: "api-1", kind: "service", spec: apiSpec(RETRY_PRESETS.backoff) as Record<string, unknown> },
        { id: "api-2", kind: "service", spec: apiSpec(RETRY_PRESETS.backoff) as Record<string, unknown> },
        { id: "orders-db", kind: "datastore", spec: dbSpec() as Record<string, unknown> },
      ],
      edges: [
        { from: "gateway", to: "api-1" },
        { from: "gateway", to: "api-2" },
        { from: "api-1", to: "orders-db" },
        { from: "api-2", to: "orders-db" },
      ],
    },
    // One long segment: the live control replaces it wholesale as the operator
    // drags, and each replacement is recorded as a mutation.
    load: [{ rate: DEMO_BASE_RATE, duration: 3600 }],
    seed: "demo-v1",
    mutations: [],
    bucketWidth: LIVE_BUCKET_WIDTH,
  };
}

/**
 * What a stranger sees when they open the file with nobody presenting.
 *
 * The arc (F3) was built to be *performed*: somebody drags the load and narrates
 * the collapse. Opened cold it is a green system doing nothing, and a viewer with
 * no idea what to touch learns nothing from it. This is the smallest thing that
 * fixes that: six steps, each an action and what to watch for.
 *
 * Every figure is computed from the model's own specs. A tour is a set of claims
 * about a system, and claims about this system are supposed to be tested.
 */
export interface GuidanceStep {
  /** What to do. */
  action: string;
  /** What happens, and why it is worth watching. */
  watch: string;
  /**
   * The label of the preset control the step asks for, when it asks for one.
   * The control column scrolls, and on a laptop-height window the control the
   * tour's payoff step needs sits below the fold with nothing saying so.
   */
  control?: string;
}

export interface Guidance {
  title: string;
  intro: string;
  steps: readonly GuidanceStep[];
}

export function demoGuidance(): Guidance {
  const dbPerSecond = Math.round(DB_CONNECTIONS / DB_SERVICE_MEAN);
  const timeoutMs = Math.round(API_TIMEOUT * 1000);
  const attempts = RETRY_PRESETS.backoff.attempts;

  return {
    title: "A sixty-second tour",
    // The intro says what is about to happen, not what the tool is: a viewer who
    // knows the database copes with 50 a second is watching for the moment it
    // stops coping at 44.
    intro:
      `This database handles about ${dbPerSecond} requests a second. You are about to take it down at ` +
      `${DEMO_COLLAPSE_RATE}, then bring it back with one setting. Everything on screen is simulated live from the model.`,
    steps: [
      {
        action: `Drag Load to ${DEMO_COLLAPSE_RATE}/s.`,
        watch: `That is still under the database's ${dbPerSecond} a second. Nothing should break.`,
      },
      {
        action: "Watch the database.",
        watch: `Its queue fills, calls miss the ${timeoutMs} ms timeout, and each miss becomes up to ${attempts} retries.`,
      },
      {
        action: "Watch Completing at the top.",
        watch:
          "The retries are extra load on the component that is already behind. Completing falls to zero while " +
          "every box stays busy.",
      },
      {
        action: "Set Retry policy to No retries.",
        control: "Retry policy",
        // Measured, and deliberately not rounded up into a clean fix: at this
        // load the timeout is still clipping roughly a fifth of calls once the
        // retries stop, so goodput comes back to most of the offered load rather
        // than all of it. A tour that promised a total recovery would be selling
        // the tool with a claim the tool itself contradicts on screen. The point
        // leads; the caveat follows it.
        watch:
          "Completing comes back within seconds, with nothing restarted. The system had the capacity all along; " +
          `the retries were what failed it. (It recovers most of the way, not all of it: the ${timeoutMs} ms ` +
          "timeout still cuts off some calls at this load.)",
      },
      {
        action: "Press Breaking point.",
        watch: "It tries one load after another and reports the range where this design stops coping.",
      },
      {
        // The tour ends on the reader's own system, not on the demo's.
        action: "Press Edit model.",
        watch: "Try the same thing on your own system.",
      },
    ],
  };
}

export function demoControls(): RunControls {
  return {
    load: { min: 5, max: DEMO_MAX_RATE, base: DEMO_BASE_RATE, step: 1 },
    presets: [
      {
        nodeIds: ["api-1", "api-2"],
        label: "Retry policy",
        initial: "backoff",
        options: [
          {
            value: "backoff",
            label: "Backoff ×3",
            note: "Three retries, doubling the wait. Turns one slow dependency into four times the work.",
            spec: { retry: RETRY_PRESETS.backoff },
          },
          {
            value: "capped",
            label: "Capped ×1",
            note: "The obvious fix. Halves the amplification and still cannot escape — one extra attempt is one too many here.",
            spec: { retry: RETRY_PRESETS.capped },
          },
          {
            // Measured over five minutes on five seeds after a collapse at 44/s:
            // 21–29/s with a 10% budget, against 33–37/s with no retries and zero
            // with none. It bounds the damage rather than undoing it, because at a
            // 250 ms timeout every retry here is work for a database already behind.
            value: "budgeted",
            label: "Backoff ×3, 10% budget",
            note:
              "Retries capped at a tenth of requests. Throughput comes back, but stalls now and then and stays " +
              "below No retries: here, any retry is extra work for a database that is already behind.",
            spec: { retry: RETRY_PRESETS.budgeted },
          },
          {
            value: "none",
            label: "No retries",
            note: "Offered load only. The backlog drains and throughput comes back.",
            spec: { retry: RETRY_PRESETS.none },
          },
        ],
      },
      {
        nodeIds: ["orders-db"],
        label: "Database queue",
        initial: "hold",
        options: [
          {
            value: "hold",
            label: "Queue everything",
            note: "Thirty callers may wait. Nothing is lost; everything is late.",
            spec: { queue: { policy: "fifo", capacity: 30 } },
          },
          {
            value: "shed",
            label: "Shed stale work",
            note: "Six deep, oldest thrown away first. Sheds the backlog that was feeding the retries.",
            spec: { queue: { policy: "drop-oldest", capacity: 6 } },
          },
        ],
      },
    ],
    capacities: [
      {
        nodeIds: ["orders-db"],
        kind: "datastore",
        label: "Database capacity",
        // The number the whole demo turns on, and the one a room argues about:
        // nobody predicts a collapse at 44/s from "it does about fifty".
        note: "What this database can sustain. Throughput on the gauge sits below it whenever anything is queueing.",
      },
      {
        nodeIds: ["api-1", "api-2"],
        kind: "service",
        label: "API capacity",
        // Stated PER REPLICA and applied to both — the earlier wording said
        // "across both replicas", which was wrong and invited exactly the
        // arithmetic it should have prevented ("two servers at 25 covers 35").
        // Worth a caveat beyond that: this is the tier's *own* work, and it is
        // not what bounds it. Each replica holds a thread while the database
        // answers (call-and-wait), so the ceiling here is threads against the
        // database's latency, not the application's own milliseconds.
        note: "Each replica's own work per request, applied to both. It is rarely the limit: what binds this tier is threads held waiting on the database.",
      },
    ],
    timeouts: [
      {
        nodeIds: ["api-1", "api-2"],
        kind: "service",
        label: "API timeout",
        // The cheapest lever on this whole model, and the least obvious. A
        // caller that gives up does not stop the database working on what it
        // abandoned, so a short timeout spends the database twice and asks for
        // the answer again.
        note: "How long a replica waits for the database before giving up and retrying. Short timeouts turn slow answers into extra load.",
      },
    ],
    // The demo's database is this design's alone. Other traffic is a claim about
    // a shared component, and putting an invented one here would change every
    // number this demo's narrative is tested against for the sake of a feature
    // tour — it belongs on a model of a system that really does share a spine.
    traffic: [],
    calls: [],
  };
}

/**
 * The demo system as an editable document.
 *
 * What "Edit" opens. Building it from the same numbers as `demoTimeline` rather
 * than converting the timeline keeps one statement of the demo: a conversion
 * would let the two drift, and the first symptom would be an author editing a
 * system that is not the one they were just watching.
 */
export function demoDocument(): WhiteboardDocument {
  let doc = emptyDocument("Orders (demo)");
  doc = addComponent(doc, { kind: "balancer", preset: "balancer/round-robin", spec: { balancer: { policy: "round-robin" } } }).document;
  doc = addComponent(doc, { kind: "service", spec: apiSpec(RETRY_PRESETS.backoff) }).document;
  doc = addComponent(doc, { kind: "service", spec: apiSpec(RETRY_PRESETS.backoff) }).document;
  doc = addComponent(doc, { kind: "datastore", spec: dbSpec() }).document;

  // The names the tour and the opening run use. Generated names here once made
  // the same demo `api-1` on one screen and `service-1` on the next.
  doc = renameComponent(doc, "balancer-1", "gateway");
  doc = renameComponent(doc, "service-1", "api-1");
  doc = renameComponent(doc, "service-2", "api-2");
  doc = renameComponent(doc, "datastore-1", "orders-db");

  doc = connect(doc, "gateway", "api-1");
  doc = connect(doc, "gateway", "api-2");
  doc = connect(doc, "api-1", "orders-db");
  doc = connect(doc, "api-2", "orders-db");

  return setLoad(doc, [{ rate: DEMO_BASE_RATE, duration: 3600 }]);
}
