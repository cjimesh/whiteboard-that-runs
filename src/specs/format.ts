/**
 * The behavior-spec format (R2).
 *
 * A component's behavior is data: a set of *concerns*, each a closed policy enum
 * plus its parameters. Components interpret specs; nothing branches on a preset
 * name. That is what makes "add a new preset" a data change rather than an
 * engine change, and it is the exact seam a later words-to-spec compiler
 * targets — it would emit one of these objects and nothing else would move.
 *
 * Two shape decisions worth stating, because both look like sloppiness and are
 * not:
 *
 * **Every policy keeps its full parameter set, rather than a discriminated union
 * per policy.** A union is tidier on paper, but the live parameter panel has to
 * let someone flip retry from `exponential` to `capped` mid-run, and a union
 * would mean inventing a `maxDelay` at that moment — either a silent default the
 * room never saw, or a refusal in the middle of a demo. Carrying the parameters
 * along means flipping a policy changes only which of them are read.
 *
 * **Specs are authored partially and resolved against defaults.** A saved model
 * records what the author actually set; `resolveSpec` fills the rest. Saved files
 * stay readable, and adding a concern later does not invalidate them.
 */

export const COMPONENT_KINDS = ["service", "queue", "balancer", "cache", "datastore"] as const;
export type ComponentKind = (typeof COMPONENT_KINDS)[number];

// --------------------------------------------------------------- concerns

/** How long a unit of work occupies a server here. `mean` is in seconds. */
export const SERVICE_TIME_POLICIES = ["fixed", "exponential"] as const;
export type ServiceTimePolicy = (typeof SERVICE_TIME_POLICIES)[number];
export interface ServiceTimeSpec {
  policy: ServiceTimePolicy;
  mean: number;
}

/**
 * What happens to work that arrives with the buffer already full.
 *
 * `fifo` refuses the newcomer (tail drop). `drop-oldest` evicts the longest-
 * waiting item instead, which is how a system keeps latency bounded by throwing
 * away work that is already stale. `priority` serves lower attempt numbers
 * first, so a first try beats a retry — the shape of shedding retry traffic to
 * protect fresh requests, and the only priority ordering the MVP can express
 * without a request-class concept it does not have.
 */
export const QUEUE_POLICIES = ["fifo", "priority", "drop-oldest"] as const;
export type QueuePolicy = (typeof QUEUE_POLICIES)[number];
export interface QueueSpec {
  policy: QueuePolicy;
  /** How many may wait, not counting those in service. */
  capacity: number;
}

/** How long this component waits on a downstream call before giving up. */
export const TIMEOUT_POLICIES = ["none", "fixed"] as const;
export type TimeoutPolicy = (typeof TIMEOUT_POLICIES)[number];
export interface TimeoutSpec {
  policy: TimeoutPolicy;
  after: number;
}

/**
 * What this component does when a downstream call fails or times out.
 *
 * `exponential` grows the wait without bound; `capped` clamps it at `maxDelay`.
 * `attempts` counts *extra* tries beyond the first, and is the parameter that
 * actually governs how much extra load a failure turns into.
 */
export const RETRY_POLICIES = ["none", "fixed", "exponential", "capped"] as const;
export type RetryPolicy = (typeof RETRY_POLICIES)[number];
export interface RetrySpec {
  policy: RetryPolicy;
  /** Extra attempts beyond the first. 0 behaves like `none`. */
  attempts: number;
  /** Base wait before the first retry, in seconds. */
  delay: number;
  /** Multiplier per subsequent retry, for `exponential` and `capped`. */
  factor: number;
  /** Ceiling on the wait, for `capped`. */
  maxDelay: number;
  /**
   * The share of requests that may be retried, 0 to 1; 0 means no budget, so
   * every failure may use every attempt. See `retry.ts` for how it is spent.
   * Optional so that every policy written before budgets existed still is one.
   */
  budget?: number;
}

/**
 * Whether this component waits for what it sends on.
 *
 * `call-and-wait` keeps holding its server until the callee answers — a
 * synchronous request, a thread and a connection tied up. `fire-and-forget`
 * releases immediately, which is a producer dropping a message and moving on.
 * The difference decides whether downstream slowness propagates back as
 * saturation here, so it is a policy the author picks, never an assumption.
 */
export const DOWNSTREAM_POLICIES = ["call-and-wait", "fire-and-forget"] as const;
export type DownstreamPolicy = (typeof DOWNSTREAM_POLICIES)[number];
export interface DownstreamSpec {
  policy: DownstreamPolicy;
}

/** How a balancer picks among its outgoing edges. */
export const BALANCER_POLICIES = ["round-robin", "random", "least-queue"] as const;
export type BalancerPolicy = (typeof BALANCER_POLICIES)[number];
export interface BalancerSpec {
  policy: BalancerPolicy;
}

/**
 * How long this component's slot stays taken *after* it has answered.
 *
 * The concern exists because a real system turned out to be limited by one: a
 * request claims a session from a pool, gets an answer in a couple of seconds,
 * and the session stays held for a minute or more, released by a different
 * request entirely. Every other component here frees its concurrency the moment
 * work leaves it, and drawn that way the pool reads as nearly idle while it is
 * in fact the only thing that binds.
 *
 * `mean` is the **whole** time the slot is occupied, not the extra beyond the
 * answer, because "a session is held for about a minute" is the number an author
 * has and "fifty-eight seconds beyond the allocation" is not.
 *
 * The caller is answered after the service time, or when the slot frees,
 * whichever comes first — so a hold shorter than the service time is a harmless
 * degenerate rather than a contradiction.
 *
 * `none` is not a special case in the engine so much as the absence of one: the
 * slot is held for the service time, which is what every component did before
 * this concern existed.
 */
export const HOLD_POLICIES = ["none", "fixed", "exponential"] as const;
export type HoldPolicy = (typeof HOLD_POLICIES)[number];
export interface HoldSpec {
  policy: HoldPolicy;
  /** Total seconds the slot is occupied, counted from when it was taken. */
  mean: number;
}

/** Cache behavior. `fixed-ratio` is a stated hit ratio, not a modelled key space. */
export const CACHE_POLICIES = ["fixed-ratio"] as const;
export type CachePolicy = (typeof CACHE_POLICIES)[number];
export interface CacheSpec {
  policy: CachePolicy;
  hitRatio: number;
}

// --------------------------------------------------------------- the spec

export interface ComponentSpec {
  /** Servers, threads, or pooled connections working at once. */
  concurrency: number;
  service: ServiceTimeSpec;
  queue: QueueSpec;
  timeout: TimeoutSpec;
  retry: RetrySpec;
  hold: HoldSpec;
  downstream: DownstreamSpec;
  balancer: BalancerSpec;
  cache: CacheSpec;
}

export type ConcernName = keyof ComponentSpec;
export type PartialComponentSpec = Partial<ComponentSpec>;

/** Which concerns each kind actually reads. Authoring any other is an error. */
export const CONCERNS: Record<ComponentKind, readonly ConcernName[]> = {
  // `hold` belongs to the shared server core rather than to any one kind, so
  // every kind built on that core reads it. Restricting it to the datastore —
  // where the case that produced it happens to live — would be a guess about
  // which components are allowed to lend something out.
  service: ["concurrency", "service", "queue", "timeout", "retry", "hold", "downstream"],
  queue: ["concurrency", "service", "queue", "hold", "downstream"],
  balancer: ["balancer"],
  cache: ["concurrency", "service", "queue", "cache", "hold", "downstream"],
  datastore: ["concurrency", "service", "queue", "hold"],
};

const BASE_DEFAULTS: ComponentSpec = {
  concurrency: 1,
  service: { policy: "exponential", mean: 0.04 },
  queue: { policy: "fifo", capacity: 100 },
  timeout: { policy: "none", after: 1 },
  retry: { policy: "none", attempts: 2, delay: 0.1, factor: 2, maxDelay: 1, budget: 0 },
  hold: { policy: "none", mean: 60 },
  downstream: { policy: "call-and-wait" },
  balancer: { policy: "round-robin" },
  cache: { policy: "fixed-ratio", hitRatio: 0.8 },
};

/**
 * Per-kind defaults, so a component dropped on the canvas behaves plausibly
 * before anyone touches a parameter. A single-threaded service and a
 * single-connection datastore are both technically defensible defaults and both
 * misleading in a review, which is a worse failure than a wrong number someone
 * argues with.
 */
const KIND_DEFAULTS: Record<ComponentKind, PartialComponentSpec> = {
  service: {
    concurrency: 20,
    service: { policy: "exponential", mean: 0.04 },
  },
  queue: {
    concurrency: 4,
    service: { policy: "exponential", mean: 0.05 },
    queue: { policy: "fifo", capacity: 10_000 },
    downstream: { policy: "fire-and-forget" },
  },
  balancer: {},
  cache: {
    concurrency: 50,
    service: { policy: "fixed", mean: 0.001 },
    queue: { policy: "fifo", capacity: 1_000 },
  },
  datastore: {
    concurrency: 10,
    service: { policy: "exponential", mean: 0.01 },
    queue: { policy: "fifo", capacity: 200 },
  },
};

/** Fill a partially-authored spec. Every concern is present on the result. */
export function resolveSpec(kind: ComponentKind, partial: PartialComponentSpec = {}): ComponentSpec {
  const kindDefaults = KIND_DEFAULTS[kind];
  return {
    concurrency: partial.concurrency ?? kindDefaults.concurrency ?? BASE_DEFAULTS.concurrency,
    service: { ...BASE_DEFAULTS.service, ...kindDefaults.service, ...partial.service },
    queue: { ...BASE_DEFAULTS.queue, ...kindDefaults.queue, ...partial.queue },
    timeout: { ...BASE_DEFAULTS.timeout, ...kindDefaults.timeout, ...partial.timeout },
    retry: { ...BASE_DEFAULTS.retry, ...kindDefaults.retry, ...partial.retry },
    hold: { ...BASE_DEFAULTS.hold, ...kindDefaults.hold, ...partial.hold },
    downstream: { ...BASE_DEFAULTS.downstream, ...kindDefaults.downstream, ...partial.downstream },
    balancer: { ...BASE_DEFAULTS.balancer, ...kindDefaults.balancer, ...partial.balancer },
    cache: { ...BASE_DEFAULTS.cache, ...kindDefaults.cache, ...partial.cache },
  };
}

/** The default spec for a kind, as a fresh object the caller may edit. */
export function defaultSpec(kind: ComponentKind): ComponentSpec {
  return resolveSpec(kind);
}

/**
 * Resolve, but refuse a spec that does not validate.
 *
 * Used where a component reads its own spec, so a policy value outside its enum
 * stops the run instead of falling through a `switch` into whatever happens to
 * be next. A model that silently ignores the setting an author just changed is
 * the worst outcome available here: it produces a confident number and an
 * unfixable argument.
 */
export function resolveSpecStrict(kind: ComponentKind, raw: unknown, nodeId: string): ComponentSpec {
  const validation = validateSpec(kind, raw, { strictConcerns: false });
  if (!validation.ok) {
    throw new Error(
      `node "${nodeId}" (${kind}) has an invalid spec:\n  ${validation.errors.join("\n  ")}`,
    );
  }
  return resolveSpec(kind, raw as PartialComponentSpec);
}

// --------------------------------------------------------------- validation

export interface SpecValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkPolicy(
  concern: string,
  value: unknown,
  allowed: readonly string[],
  errors: string[],
): boolean {
  const policy = isRecord(value) ? value["policy"] : undefined;
  if (policy === undefined) {
    errors.push(`${concern}: missing "policy". Expected one of: ${allowed.join(", ")}`);
    return false;
  }
  if (typeof policy !== "string" || !allowed.includes(policy)) {
    errors.push(
      `${concern}: "${String(policy)}" is not a known policy. Expected one of: ${allowed.join(", ")}`,
    );
    return false;
  }
  return true;
}

function checkNumber(
  concern: string,
  value: unknown,
  field: string,
  test: (n: number) => boolean,
  requirement: string,
  errors: string[],
): void {
  if (!isRecord(value) || value[field] === undefined) return; // absent is fine; defaults fill it
  const n = value[field];
  if (typeof n !== "number" || !Number.isFinite(n) || !test(n)) {
    errors.push(`${concern}.${field} must be ${requirement}, got ${JSON.stringify(n)}`);
  }
}

export interface ValidateOptions {
  /**
   * Whether to reject concerns the kind does not read. True when checking
   * something a person authored; false when checking something already resolved.
   *
   * The distinction matters because `resolveSpec` deliberately returns a total
   * record — every concern present, so no component has to guard a read — which
   * means a resolved spec carries fields its own kind ignores. Feeding one back
   * in is normal (a preset's resolved form becoming a node's spec), and it must
   * not be an error. Authoring `retry` on a datastore, on the other hand, is a
   * mistake worth stopping: it will be silently ignored, and the author will
   * spend the review wondering why changing it does nothing.
   */
  strictConcerns?: boolean;
}

/**
 * Check a spec.
 *
 * Always strict about what makes a spec *unrunnable* — a policy value outside
 * its enum, a parameter out of range — because those leave component behavior
 * undefined. Strict about unused concerns only when someone authored it; see
 * `ValidateOptions`.
 */
export function validateSpec(kind: string, raw: unknown, options: ValidateOptions = {}): SpecValidation {
  const strictConcerns = options.strictConcerns ?? true;
  const errors: string[] = [];

  if (!(COMPONENT_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      errors: [`"${kind}" is not a component kind. Expected one of: ${COMPONENT_KINDS.join(", ")}`],
    };
  }
  if (!isRecord(raw)) {
    return { ok: false, errors: [`spec for a ${kind} must be an object, got ${JSON.stringify(raw)}`] };
  }

  const applicable = CONCERNS[kind as ComponentKind];
  if (strictConcerns) {
    for (const key of Object.keys(raw)) {
      if (!applicable.includes(key as ConcernName)) {
        errors.push(
          `a ${kind} does not use "${key}", so setting it would have no effect. ` +
            `It reads: ${applicable.join(", ")}`,
        );
      }
    }
  }

  if (raw["concurrency"] !== undefined) {
    const n = raw["concurrency"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      errors.push(`concurrency must be a whole number of at least 1, got ${JSON.stringify(n)}`);
    }
  }

  if (raw["service"] !== undefined && checkPolicy("service", raw["service"], SERVICE_TIME_POLICIES, errors)) {
    checkNumber("service", raw["service"], "mean", (n) => n >= 0, "a non-negative number of seconds", errors);
  }

  if (raw["queue"] !== undefined && checkPolicy("queue", raw["queue"], QUEUE_POLICIES, errors)) {
    checkNumber(
      "queue",
      raw["queue"],
      "capacity",
      (n) => Number.isInteger(n) && n >= 0,
      "a whole number of at least 0",
      errors,
    );
  }

  if (raw["timeout"] !== undefined && checkPolicy("timeout", raw["timeout"], TIMEOUT_POLICIES, errors)) {
    checkNumber("timeout", raw["timeout"], "after", (n) => n > 0, "a positive number of seconds", errors);
  }

  if (raw["retry"] !== undefined && checkPolicy("retry", raw["retry"], RETRY_POLICIES, errors)) {
    checkNumber(
      "retry",
      raw["retry"],
      "attempts",
      (n) => Number.isInteger(n) && n >= 0,
      "a whole number of at least 0",
      errors,
    );
    checkNumber("retry", raw["retry"], "delay", (n) => n >= 0, "a non-negative number of seconds", errors);
    checkNumber("retry", raw["retry"], "factor", (n) => n >= 1, "at least 1", errors);
    checkNumber("retry", raw["retry"], "maxDelay", (n) => n >= 0, "a non-negative number of seconds", errors);
    checkNumber("retry", raw["retry"], "budget", (n) => n >= 0 && n <= 1, "a share between 0 and 1", errors);
  }

  if (raw["hold"] !== undefined && checkPolicy("hold", raw["hold"], HOLD_POLICIES, errors)) {
    checkNumber("hold", raw["hold"], "mean", (n) => n > 0, "a positive number of seconds", errors);
  }

  if (raw["downstream"] !== undefined) {
    checkPolicy("downstream", raw["downstream"], DOWNSTREAM_POLICIES, errors);
  }
  if (raw["balancer"] !== undefined) {
    checkPolicy("balancer", raw["balancer"], BALANCER_POLICIES, errors);
  }
  if (raw["cache"] !== undefined && checkPolicy("cache", raw["cache"], CACHE_POLICIES, errors)) {
    checkNumber("cache", raw["cache"], "hitRatio", (n) => n >= 0 && n <= 1, "between 0 and 1", errors);
  }

  return { ok: errors.length === 0, errors };
}
