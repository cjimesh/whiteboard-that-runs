/**
 * Metrics, accumulated on sim-time boundaries inside the kernel.
 *
 * This placement is the whole point. The obvious alternative is to let the
 * render loop sample state each frame and build the series from that, which
 * would make every number a function of how fast the machine drew — a run
 * recorded on a laptop under load would not replay on a fresh one, and the
 * headless sweep would disagree with the live view it is supposed to explain.
 *
 * So the kernel closes a metrics window every `bucketWidth` sim seconds,
 * whatever is driving it, and the renderer only ever reads the series that
 * results. Windows are half-open, `[start, end)`: an event stamped exactly on a
 * boundary belongs to the window it opens (see `EventPriority.BUCKET`).
 *
 * Levels — queue depth, busy servers, jobs resident in a node — are integrated
 * over sim time rather than sampled at the boundary, so a queue that spikes and
 * drains inside one window still shows up in that window's mean. That integral
 * is also `L` in Little's Law, which is how the validation suite (R13) checks
 * `L = λW` per node without the components having to cooperate.
 *
 * Each level is integrated lazily, at its own changes and at window boundaries,
 * never on a global tick. That is not just cheaper — it is what keeps the delta
 * toggle exact. Integrating every node on every event would splice each node's
 * integral into as many floating-point additions as there were events anywhere
 * in the model, so adding an unrelated component would perturb an untouched
 * component's averages in the last digit. Small, but it would mean "the numbers
 * for this queue are identical with and without the proposal" stopped being
 * literally true, and that claim is the delta toggle's whole warrant.
 */

export interface NodeBucket {
  /** Jobs admitted to this node during the window. */
  arrivals: number;
  /** Jobs that left this node — forwarded on or completed. */
  departures: number;
  drops: number;
  /**
   * Jobs this node served for a caller that had already stopped waiting.
   *
   * The work was done and its result is thrown away, so for whoever asked it is
   * as lost as a drop. A deep queue in overload loses work this way rather than
   * by dropping it: nothing is turned away, every caller times out first.
   */
  wasted: number;
  timeouts: number;
  retries: number;
  /** Time spent in this node, per job that left it during the window. */
  sojournMean: number;
  sojournP50: number;
  sojournP95: number;
  sojournP99: number;
  /** Time-averaged number of jobs resident in this node — `L`. */
  residentMean: number;
  /** Time-averaged number of jobs waiting (not in service), as the behavior reports it. */
  queueDepthMean: number;
  queueDepthEnd: number;
  /** Time-averaged busy servers over declared servers: 0 idle, 1 saturated. */
  utilization: number;
}

export interface SystemBucket {
  arrivals: number;
  completions: number;
  drops: number;
  /** End-to-end, from the original request's admission — so retries are counted in. */
  latencyMean: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  inFlightEnd: number;
}

/**
 * One source of other traffic, over one window.
 *
 * Separate from the system totals on purpose: the headline this tool reports is
 * about the modelled path, and folding other traffic into it would average a
 * checkout together with somebody else's Redis GET. But other traffic that
 * is being turned away needs to be visible, because a source whose requests
 * never land looks exactly like no contention at all from the node's side.
 */
export interface SourceBucket {
  /** Requests this source offered during the window. */
  arrivals: number;
  /** Requests the component served and returned. */
  completions: number;
  /** Requests the component turned away or lost. */
  drops: number;
}

export interface BucketSample {
  start: number;
  end: number;
  nodes: Record<string, NodeBucket>;
  system: SystemBucket;
  /** Per-source counts, empty when the model has no other traffic. */
  sources: Record<string, SourceBucket>;
}

export interface InstantLevels {
  queueDepth: number;
  busy: number;
  servers: number;
  resident: number;
}

/** Nearest-rank percentile over an ascending array. Deterministic by construction. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] as number;
}

/** A quantity that holds a value over time; `area` is its integral this window. */
interface Level {
  value: number;
  area: number;
  since: number;
}

function newLevel(at: number, value = 0): Level {
  return { value, area: 0, since: at };
}

/** Integrate up to `time`, then leave the level ready to hold its next value. */
function settle(level: Level, time: number): void {
  const elapsed = time - level.since;
  if (elapsed > 0) {
    level.area += level.value * elapsed;
    level.since = time;
  }
}

interface NodeAccumulator {
  arrivals: number;
  departures: number;
  drops: number;
  wasted: number;
  timeouts: number;
  retries: number;
  sojourns: number[];
  resident: Level;
  queueDepth: Level;
  busy: Level;
  servers: Level;
}

function newNode(at: number): NodeAccumulator {
  return {
    arrivals: 0,
    departures: 0,
    drops: 0,
    wasted: 0,
    timeouts: 0,
    retries: 0,
    sojourns: [],
    resident: newLevel(at),
    queueDepth: newLevel(at),
    busy: newLevel(at),
    servers: newLevel(at, 1),
  };
}

export interface MetricsRecorder {
  nodeArrival(nodeId: string): void;
  nodeDeparture(nodeId: string, sojourn: number): void;
  nodeDrop(nodeId: string): void;
  nodeWasted(nodeId: string): void;
  nodeTimeout(nodeId: string): void;
  nodeRetry(nodeId: string): void;
  setQueueDepth(nodeId: string, depth: number): void;
  setBusy(nodeId: string, busy: number, servers?: number): void;
  adjustResident(nodeId: string, delta: number): void;
  systemArrival(): void;
  systemCompletion(latency: number): void;
  systemDrop(): void;
  sourceArrival(sourceId: string): void;
  sourceCompletion(sourceId: string): void;
  sourceDrop(sourceId: string): void;
  /** Close the window ending at `time` and start the next one. */
  closeBucket(time: number): void;
  series(): readonly BucketSample[];
  /** Instantaneous levels, for the live view to paint. Never feeds the series. */
  levels(): Record<string, InstantLevels>;
  inFlight(): number;
}

interface SourceAccumulator {
  arrivals: number;
  completions: number;
  drops: number;
}

export function createMetrics(nodeIds: readonly string[], now: () => number): MetricsRecorder {
  const nodes = new Map<string, NodeAccumulator>();
  // Fixed insertion order so serialised buckets compare byte for byte.
  const order = [...nodeIds];
  for (const id of order) nodes.set(id, newNode(now()));

  let bucketStart = 0;
  let inFlight = 0;
  let systemArrivals = 0;
  let systemCompletions = 0;
  let systemDrops = 0;
  let latencies: number[] = [];
  const buckets: BucketSample[] = [];
  // Created on first use and kept in first-seen order, like the node map above,
  // so serialised buckets still compare byte for byte.
  const sources = new Map<string, SourceAccumulator>();
  const sourceOrder: string[] = [];

  const sourceAccumulator = (sourceId: string): SourceAccumulator => {
    let source = sources.get(sourceId);
    if (source === undefined) {
      source = { arrivals: 0, completions: 0, drops: 0 };
      sources.set(sourceId, source);
      sourceOrder.push(sourceId);
    }
    return source;
  };

  const accumulator = (nodeId: string): NodeAccumulator => {
    let node = nodes.get(nodeId);
    if (node === undefined) {
      node = newNode(now());
      nodes.set(nodeId, node);
      order.push(nodeId);
    }
    return node;
  };

  return {
    nodeArrival(nodeId) {
      accumulator(nodeId).arrivals += 1;
    },
    nodeDeparture(nodeId, sojourn) {
      const node = accumulator(nodeId);
      node.departures += 1;
      node.sojourns.push(sojourn);
    },
    nodeDrop(nodeId) {
      accumulator(nodeId).drops += 1;
    },
    nodeWasted(nodeId) {
      accumulator(nodeId).wasted += 1;
    },
    nodeTimeout(nodeId) {
      accumulator(nodeId).timeouts += 1;
    },
    nodeRetry(nodeId) {
      accumulator(nodeId).retries += 1;
    },

    setQueueDepth(nodeId, depth) {
      const level = accumulator(nodeId).queueDepth;
      settle(level, now());
      level.value = depth;
    },
    setBusy(nodeId, busy, servers) {
      const node = accumulator(nodeId);
      const at = now();
      settle(node.busy, at);
      node.busy.value = busy;
      if (servers !== undefined) {
        settle(node.servers, at);
        node.servers.value = servers;
      }
    },
    adjustResident(nodeId, delta) {
      const level = accumulator(nodeId).resident;
      settle(level, now());
      level.value += delta;
    },

    systemArrival() {
      systemArrivals += 1;
      inFlight += 1;
    },
    systemCompletion(latency) {
      systemCompletions += 1;
      inFlight -= 1;
      latencies.push(latency);
    },
    systemDrop() {
      systemDrops += 1;
      inFlight -= 1;
    },

    sourceArrival(sourceId) {
      sourceAccumulator(sourceId).arrivals += 1;
    },
    sourceCompletion(sourceId) {
      sourceAccumulator(sourceId).completions += 1;
    },
    sourceDrop(sourceId) {
      sourceAccumulator(sourceId).drops += 1;
    },

    closeBucket(time) {
      const width = time - bucketStart;
      const sortedLatencies = [...latencies].sort((a, b) => a - b);
      const sample: BucketSample = {
        start: bucketStart,
        end: time,
        nodes: {},
        sources: {},
        system: {
          arrivals: systemArrivals,
          completions: systemCompletions,
          drops: systemDrops,
          latencyMean:
            latencies.length === 0 ? 0 : latencies.reduce((a, b) => a + b, 0) / latencies.length,
          latencyP50: percentile(sortedLatencies, 0.5),
          latencyP95: percentile(sortedLatencies, 0.95),
          latencyP99: percentile(sortedLatencies, 0.99),
          inFlightEnd: inFlight,
        },
      };

      for (const id of order) {
        const node = nodes.get(id);
        if (node === undefined) continue;
        settle(node.resident, time);
        settle(node.queueDepth, time);
        settle(node.busy, time);
        settle(node.servers, time);

        const sorted = [...node.sojourns].sort((a, b) => a - b);
        sample.nodes[id] = {
          arrivals: node.arrivals,
          departures: node.departures,
          drops: node.drops,
          wasted: node.wasted,
          timeouts: node.timeouts,
          retries: node.retries,
          sojournMean:
            node.sojourns.length === 0
              ? 0
              : node.sojourns.reduce((a, b) => a + b, 0) / node.sojourns.length,
          sojournP50: percentile(sorted, 0.5),
          sojournP95: percentile(sorted, 0.95),
          sojournP99: percentile(sorted, 0.99),
          residentMean: width > 0 ? node.resident.area / width : 0,
          queueDepthMean: width > 0 ? node.queueDepth.area / width : 0,
          queueDepthEnd: node.queueDepth.value,
          utilization: node.servers.area > 0 ? node.busy.area / node.servers.area : 0,
        };

        node.arrivals = 0;
        node.departures = 0;
        node.drops = 0;
        node.wasted = 0;
        node.timeouts = 0;
        node.retries = 0;
        node.sojourns = [];
        node.resident.area = 0;
        node.queueDepth.area = 0;
        node.busy.area = 0;
        node.servers.area = 0;
      }

      for (const id of sourceOrder) {
        const source = sources.get(id);
        if (source === undefined) continue;
        sample.sources[id] = {
          arrivals: source.arrivals,
          completions: source.completions,
          drops: source.drops,
        };
        source.arrivals = 0;
        source.completions = 0;
        source.drops = 0;
      }

      buckets.push(sample);
      bucketStart = time;
      systemArrivals = 0;
      systemCompletions = 0;
      systemDrops = 0;
      latencies = [];
    },

    series: () => buckets,

    levels() {
      const out: Record<string, InstantLevels> = {};
      for (const id of order) {
        const node = nodes.get(id);
        if (node === undefined) continue;
        out[id] = {
          queueDepth: node.queueDepth.value,
          busy: node.busy.value,
          servers: node.servers.value,
          resident: node.resident.value,
        };
      }
      return out;
    },

    inFlight: () => inFlight,
  };
}
