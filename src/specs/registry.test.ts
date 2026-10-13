import { describe, expect, it } from "vitest";
import { createSimulation } from "../engine/kernel.ts";
import type { BucketSample } from "../engine/metrics.ts";
import { COMPONENT_KINDS, resolveSpec, type ComponentKind } from "./format.ts";
import { BEHAVIORS, BUILT_IN_PRESETS, createPresetRegistry, type Preset } from "./registry.ts";

/**
 * The R2 seam, asserted rather than asserted-about.
 *
 * The plan's success criterion is that a new behavior preset requires authoring a
 * spec and nothing else. The way to test that claim is to write a preset here,
 * in a test file, using a combination of policies no built-in uses — and then run
 * a real model on it. If any component needed a code path for it, this fails.
 */

const sumNode = (series: readonly BucketSample[], id: string, key: keyof NonNullable<BucketSample["nodes"][string]>): number =>
  series.reduce((total, bucket) => total + (bucket.nodes[id]?.[key] ?? 0), 0);

const maxNode = (series: readonly BucketSample[], id: string, key: keyof NonNullable<BucketSample["nodes"][string]>): number =>
  series.reduce((most, bucket) => Math.max(most, bucket.nodes[id]?.[key] ?? 0), 0);

describe("the built-in palette", () => {
  it("registers without complaint, so every shipped preset is a valid spec", () => {
    expect(() => createPresetRegistry()).not.toThrow();
    expect(BUILT_IN_PRESETS.length).toBeGreaterThan(10);
  });

  it("offers at least one preset for every component kind", () => {
    const registry = createPresetRegistry();
    for (const kind of COMPONENT_KINDS) {
      expect(registry.list(kind).length, `no preset for ${kind}`).toBeGreaterThan(0);
    }
  });

  it("has a behavior registered for every kind, and no kinds beyond the palette", () => {
    expect(Object.keys(BEHAVIORS).sort()).toEqual([...COMPONENT_KINDS].sort());
  });

  it("gives every preset a distinct name, a label and a note", () => {
    const names = BUILT_IN_PRESETS.map((preset) => preset.name);
    expect(new Set(names).size).toBe(names.length);
    for (const preset of BUILT_IN_PRESETS) {
      expect(preset.label.length, preset.name).toBeGreaterThan(0);
      expect(preset.note.length, preset.name).toBeGreaterThan(0);
    }
  });

  it("resolves a preset to a full spec, filling what it did not set", () => {
    const registry = createPresetRegistry();
    const spec = registry.specFor("balancer/least-loaded");

    expect(spec.balancer.policy).toBe("least-queue");
    // Unset concerns still arrive resolved, so no component reads an undefined.
    expect(spec.concurrency).toBeGreaterThan(0);
    expect(spec.queue.capacity).toBeGreaterThan(0);
  });

  it("filters by kind and keeps registration order", () => {
    const registry = createPresetRegistry();
    const services = registry.list("service");

    expect(services.every((preset) => preset.kind === "service")).toBe(true);
    expect(services[0]?.name).toBe("service/plain");
    expect(registry.list().length).toBe(BUILT_IN_PRESETS.length);
  });
});

describe("registering presets", () => {
  it("refuses a duplicate name", () => {
    const registry = createPresetRegistry();
    expect(() =>
      registry.register({
        name: "service/plain",
        kind: "service",
        label: "Clashing",
        note: "",
        spec: {},
      }),
    ).toThrow(/already registered/);
  });

  it("refuses a spec that would not validate, at registration rather than at run time", () => {
    const registry = createPresetRegistry();
    expect(() =>
      registry.register({
        name: "service/nonsense",
        kind: "service",
        label: "Nonsense",
        note: "",
        spec: { queue: { policy: "lifo" as never, capacity: 10 } },
      }),
    ).toThrow(/service\/nonsense/);
  });

  it("names what it knows when asked for a preset it does not have", () => {
    const registry = createPresetRegistry();
    expect(() => registry.get("service/telepathy")).toThrow(/service\/telepathy/);
    expect(() => registry.get("service/telepathy")).toThrow(/service\/plain/);
  });

  it("refuses a preset that sets a concern its kind will never read", () => {
    // Authoring is the strict path: a retry policy on a datastore is silently
    // ignored at run time, so the place to stop it is where it was written.
    const registry = createPresetRegistry();
    expect(() =>
      registry.register({
        name: "datastore/retrying",
        kind: "datastore",
        label: "Retrying datastore",
        note: "",
        spec: { retry: { policy: "fixed", attempts: 2, delay: 0.1, factor: 2, maxDelay: 1 } },
      }),
    ).toThrow(/datastore does not use "retry"/);
  });

  it("refuses a preset for a kind the palette does not have", () => {
    // The honest boundary of the seam: presets are data, component *kinds* are
    // code. A new kind needs a behavior, and pretending otherwise would let a
    // preset register for something nothing can run.
    const registry = createPresetRegistry();
    expect(() =>
      registry.register({
        name: "queue-broker/kafka",
        kind: "message-bus" as ComponentKind,
        label: "Message bus",
        note: "",
        spec: {},
      }),
    ).toThrow(/message-bus/);
  });
});

describe("a preset the components have never seen (R2 success criterion)", () => {
  const SYNTHETIC: Preset = {
    name: "service/burst-absorber",
    kind: "service",
    label: "Burst absorber",
    note: "Three workers, sheds stale work, retries flat, hands off without waiting.",
    spec: {
      concurrency: 3,
      service: { policy: "fixed", mean: 0.01 },
      queue: { policy: "drop-oldest", capacity: 15 },
      timeout: { policy: "fixed", after: 0.2 },
      retry: { policy: "fixed", attempts: 4, delay: 0.01, factor: 2, maxDelay: 1 },
      downstream: { policy: "fire-and-forget" },
    },
  };

  it("is a genuinely new combination, not one a built-in already covers", () => {
    const shape = JSON.stringify(resolveSpec("service", SYNTHETIC.spec));
    const existing = BUILT_IN_PRESETS.filter((preset) => preset.kind === "service").map((preset) =>
      JSON.stringify(resolveSpec("service", preset.spec)),
    );

    expect(existing).not.toContain(shape);
  });

  it("registers and runs, with every policy in it honoured", () => {
    const registry = createPresetRegistry();
    registry.register(SYNTHETIC);

    const sim = createSimulation(
      {
        model: {
          entryId: "front",
          nodes: [
            { id: "front", kind: "service", spec: registry.specFor(SYNTHETIC.name) as unknown as Record<string, unknown> },
            {
              id: "sink",
              kind: "datastore",
              spec: {
                concurrency: 40,
                service: { policy: "fixed", mean: 0.005 },
                queue: { policy: "fifo", capacity: 5_000 },
              },
            },
          ],
          edges: [{ from: "front", to: "sink" }],
        },
        // Deliberately above the three workers' 300/s ceiling, so the shedding
        // and the concurrency limit both have to show up.
        load: [{ rate: 500, duration: 10 }],
        seed: "synthetic",
        mutations: [],
        bucketWidth: 1,
      },
      BEHAVIORS,
    );
    sim.runUntil(12);
    const series = sim.series();

    // concurrency: 3 — never more than three in service at once.
    expect(maxNode(series, "front", "utilization")).toBeLessThanOrEqual(1);
    expect(sim.snapshot().nodes["front"]?.servers).toBe(3);

    // queue drop-oldest at capacity 15 — it sheds, and the buffer stays bounded.
    expect(sumNode(series, "front", "drops")).toBeGreaterThan(100);
    expect(maxNode(series, "front", "queueDepthMean")).toBeLessThanOrEqual(15);

    // fire-and-forget — work reaches the sink and the front does not hold it.
    expect(sumNode(series, "sink", "arrivals")).toBeGreaterThan(1_000);
    expect(maxNode(series, "front", "residentMean")).toBeLessThan(20);

    // And it ran: this is a working model, not a spec that merely type-checked.
    expect(series.reduce((n, b) => n + b.system.completions, 0)).toBeGreaterThan(1_000);
  });
});
