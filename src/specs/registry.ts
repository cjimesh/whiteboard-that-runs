/**
 * The two registries: which behavior runs a kind, and which named specs the
 * palette offers.
 *
 * `BEHAVIORS` is the kernel's lookup — five kinds, five interpreters, and the
 * kernel stays ignorant of all of them.
 *
 * `PRESETS` is the R2 seam made concrete. A preset is a name, a label, and a
 * partial spec. Nothing in this file is special-cased anywhere else, so adding
 * one is a data edit — which is the success criterion the plan sets for the
 * behavior-spec format, and what a later words-to-spec compiler would emit.
 * `registry.test.ts` asserts that by registering a preset the components have
 * never heard of and running a model on it.
 */
import {
  createSimulation,
  type BehaviorFactory,
  type BehaviorRegistry,
  type NodeBehavior,
  type Simulation,
} from "../engine/kernel.ts";
import type { Timeline } from "../engine/timeline.ts";
import { validateWiring } from "./wiring.ts";
import { createBalancer } from "./balancer.ts";
import { createCache } from "./cache.ts";
import { createDatastore } from "./datastore.ts";
import { createQueue } from "./queue.ts";
import { createService } from "./service.ts";
import {
  resolveSpec,
  validateSpec,
  type ComponentKind,
  type ComponentSpec,
  type PartialComponentSpec,
} from "./format.ts";

/**
 * Wraps a component factory so an unrunnable spec is refused when the model is
 * built, not discovered when the first request happens to reach that node. A
 * component nobody wired traffic to is still a component in the picture.
 */
function guard(kind: ComponentKind, make: () => NodeBehavior): BehaviorFactory {
  return (node) => {
    // Not `strictConcerns`: a node's spec is frequently a preset's resolved form,
    // which carries every concern. Authoring-time checks are where an unused
    // concern gets caught — see `ValidateOptions`.
    const validation = validateSpec(kind, node.spec, { strictConcerns: false });
    if (!validation.ok) {
      throw new Error(
        `node "${node.id}" (${kind}) has an invalid spec:\n  ${validation.errors.join("\n  ")}`,
      );
    }
    return make();
  };
}

export const BEHAVIORS: BehaviorRegistry = {
  service: guard("service", createService),
  queue: guard("queue", createQueue),
  balancer: guard("balancer", createBalancer),
  cache: guard("cache", createCache),
  datastore: guard("datastore", createDatastore),
};

export interface Preset {
  /** Stable identifier; what a saved model records. */
  readonly name: string;
  readonly kind: ComponentKind;
  /** What the palette shows. */
  readonly label: string;
  /** One line on what this models, for the parameter panel and the legend. */
  readonly note: string;
  readonly spec: PartialComponentSpec;
}

export const BUILT_IN_PRESETS: readonly Preset[] = [
  {
    name: "service/plain",
    kind: "service",
    label: "Plain service",
    note: "Waits as long as it takes. No timeout, no retries.",
    spec: {
      concurrency: 20,
      service: { policy: "exponential", mean: 0.04 },
      queue: { policy: "fifo", capacity: 200 },
      timeout: { policy: "none", after: 1 },
      retry: { policy: "none", attempts: 0, delay: 0.05, factor: 2, maxDelay: 1 },
    },
  },
  {
    name: "service/fail-fast",
    kind: "service",
    label: "Fails fast",
    note: "Gives up on a slow dependency instead of queueing behind it.",
    spec: {
      concurrency: 20,
      timeout: { policy: "fixed", after: 0.25 },
      retry: { policy: "none", attempts: 0, delay: 0.05, factor: 2, maxDelay: 1 },
    },
  },
  {
    name: "service/exponential-retry",
    kind: "service",
    label: "Retries with backoff",
    note: "Three retries, doubling the wait. Turns one slow dependency into four times the load.",
    spec: {
      concurrency: 20,
      timeout: { policy: "fixed", after: 0.25 },
      retry: { policy: "exponential", attempts: 3, delay: 0.05, factor: 2, maxDelay: 5 },
    },
  },
  {
    name: "service/capped-retry",
    kind: "service",
    label: "Retries, capped",
    note: "One retry, backoff clamped. The usual fix once a retry storm has started.",
    spec: {
      concurrency: 20,
      timeout: { policy: "fixed", after: 0.25 },
      retry: { policy: "capped", attempts: 1, delay: 0.2, factor: 2, maxDelay: 0.5 },
    },
  },
  {
    name: "service/sheds-oldest",
    kind: "service",
    label: "Sheds stale work",
    note: "Shallow buffer that throws away the longest-waiting request rather than everyone's latency.",
    spec: {
      concurrency: 20,
      queue: { policy: "drop-oldest", capacity: 40 },
      timeout: { policy: "fixed", after: 0.25 },
      retry: { policy: "none", attempts: 0, delay: 0.05, factor: 2, maxDelay: 1 },
    },
  },
  {
    name: "service/first-tries-first",
    kind: "service",
    label: "First tries first",
    note: "Serves fresh requests ahead of retries, so a retry storm cannot starve new traffic.",
    spec: {
      concurrency: 20,
      queue: { policy: "priority", capacity: 200 },
      timeout: { policy: "fixed", after: 0.25 },
      retry: { policy: "capped", attempts: 1, delay: 0.2, factor: 2, maxDelay: 0.5 },
    },
  },

  {
    name: "queue/deep-buffer",
    kind: "queue",
    label: "Deep buffer",
    note: "Absorbs a spike. Latency grows instead of work being lost.",
    spec: {
      concurrency: 4,
      service: { policy: "exponential", mean: 0.05 },
      queue: { policy: "fifo", capacity: 10_000 },
      downstream: { policy: "fire-and-forget" },
    },
  },
  {
    name: "queue/shallow-drop-oldest",
    kind: "queue",
    label: "Shallow, drops oldest",
    note: "Bounded backlog. Old messages go over the side to keep the fresh ones timely.",
    spec: {
      concurrency: 4,
      service: { policy: "exponential", mean: 0.05 },
      queue: { policy: "drop-oldest", capacity: 200 },
      downstream: { policy: "fire-and-forget" },
    },
  },

  {
    name: "balancer/round-robin",
    kind: "balancer",
    label: "Round robin",
    note: "Even split, blind to how loaded anything is.",
    spec: { balancer: { policy: "round-robin" } },
  },
  {
    name: "balancer/least-loaded",
    kind: "balancer",
    label: "Least loaded",
    note: "Routes to the shortest queue. Hides a struggling replica until they all struggle.",
    spec: { balancer: { policy: "least-queue" } },
  },
  {
    name: "balancer/random",
    kind: "balancer",
    label: "Random",
    note: "Independent choice per request.",
    spec: { balancer: { policy: "random" } },
  },

  {
    name: "cache/warm",
    kind: "cache",
    label: "Warm cache",
    note: "90% hit ratio. The origin only sees one request in ten.",
    spec: {
      concurrency: 50,
      service: { policy: "fixed", mean: 0.001 },
      cache: { policy: "fixed-ratio", hitRatio: 0.9 },
    },
  },
  {
    name: "cache/cold",
    kind: "cache",
    label: "Cold cache",
    note: "30% hit ratio — a cache after a deploy, or one whose keys have moved.",
    spec: {
      concurrency: 50,
      service: { policy: "fixed", mean: 0.001 },
      cache: { policy: "fixed-ratio", hitRatio: 0.3 },
    },
  },

  {
    name: "datastore/pooled",
    kind: "datastore",
    label: "Pooled datastore",
    note: "Ten connections. Callers queue for one; a full queue is a refused connection.",
    spec: {
      concurrency: 10,
      service: { policy: "exponential", mean: 0.01 },
      queue: { policy: "fifo", capacity: 200 },
    },
  },
  {
    name: "datastore/in-memory",
    kind: "datastore",
    label: "In-memory, single-threaded",
    note: "One request at a time, each well under a millisecond. Fast until it is not: it has no second thread to fall back on.",
    spec: {
      concurrency: 1,
      service: { policy: "exponential", mean: 0.0002 },
      queue: { policy: "fifo", capacity: 10_000 },
    },
  },
  {
    name: "datastore/session-pool",
    kind: "datastore",
    label: "Session pool",
    note: "Lends out a slot that stays taken for the whole session, long after the request that took it has had its answer.",
    spec: {
      concurrency: 100,
      service: { policy: "exponential", mean: 1 },
      queue: { policy: "fifo", capacity: 100 },
      hold: { policy: "exponential", mean: 60 },
    },
  },
  {
    name: "datastore/single-connection",
    kind: "datastore",
    label: "One connection",
    note: "The serialising dependency everyone forgets is serialising.",
    spec: {
      concurrency: 1,
      service: { policy: "exponential", mean: 0.01 },
      queue: { policy: "fifo", capacity: 200 },
    },
  },
];

export interface PresetRegistry {
  /** Add a preset. Throws on a duplicate name or a spec that would not validate. */
  register(preset: Preset): void;
  has(name: string): boolean;
  get(name: string): Preset;
  /** All presets, or just those for one kind, in registration order. */
  list(kind?: ComponentKind): readonly Preset[];
  /** The named preset's spec, resolved against defaults and ready to run. */
  specFor(name: string): ComponentSpec;
}

export function createPresetRegistry(initial: readonly Preset[] = BUILT_IN_PRESETS): PresetRegistry {
  const byName = new Map<string, Preset>();

  const register = (preset: Preset): void => {
    if (byName.has(preset.name)) {
      throw new Error(`a preset named "${preset.name}" is already registered`);
    }
    // Validated at registration rather than at run time, so a bad preset fails
    // where it was written instead of halfway through a demo.
    const validation = validateSpec(preset.kind, preset.spec);
    if (!validation.ok) {
      throw new Error(`preset "${preset.name}" is not a valid ${preset.kind} spec:\n  ${validation.errors.join("\n  ")}`);
    }
    byName.set(preset.name, preset);
  };

  for (const preset of initial) register(preset);

  const get = (name: string): Preset => {
    const preset = byName.get(name);
    if (preset === undefined) {
      throw new Error(`no preset named "${name}". Known presets: ${[...byName.keys()].join(", ")}`);
    }
    return preset;
  };

  return {
    register,
    has: (name) => byName.has(name),
    get,
    list: (kind) => [...byName.values()].filter((preset) => kind === undefined || preset.kind === kind),
    specFor: (name) => {
      const preset = get(name);
      return resolveSpec(preset.kind, preset.spec);
    },
  };
}

/** The palette the app offers. Tests build their own so they cannot pollute it. */
export const presets: PresetRegistry = createPresetRegistry();

/**
 * Build a simulation of a real palette model: wiring rules, then the kernel.
 *
 * The single entry point everything above the engine should use, so that no
 * caller can accidentally skip a check the components depend on. `createSimulation`
 * remains available for the kernel's own tests, which run on behaviors that have
 * no palette semantics to check.
 */
export function createModelSimulation(timeline: Timeline): Simulation {
  const wiring = validateWiring(timeline.model);
  if (!wiring.ok) {
    throw new Error(`this model cannot be run:\n  ${wiring.errors.join("\n  ")}`);
  }
  return createSimulation(timeline, BEHAVIORS);
}
