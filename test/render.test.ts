// Must precede the playwright import: it reads its browser path at import time.
import "../tooling-env.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { viewBundle, viewPage } from "./support/view-bundle.ts";
import type { Timeline } from "../src/engine/timeline.ts";
import { demoTimeline } from "../src/ui/demo.ts";

/**
 * Paints every model shape in a real browser.
 *
 * `frame.ts` is proven pure by its own unit tests, and those run without a canvas
 * — which is exactly what they cannot check. A frame full of `Infinity`, a
 * zero-width ribbon, a node sized down to nothing: all of those pass a pure test
 * and throw or paint nothing in a real 2D context. This is the other half.
 */

let browser: Browser;
let page: Page;
let bundle: string;

beforeAll(async () => {
  bundle = await viewBundle();
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
}, 180_000);

afterAll(async () => {
  await browser?.close();
});

interface Outcome {
  ok: boolean;
  nodes: number;
  edges: number;
  error?: string;
}

async function render(timeline: Timeline, seconds: number): Promise<Outcome> {
  await page.setContent(viewPage(bundle, JSON.stringify(timeline), seconds));
  return page.evaluate(() => (window as never as { __result: Outcome }).__result);
}

const service = (id: string, spec: Record<string, unknown> = {}): Timeline["model"]["nodes"][number] => ({
  id,
  kind: "service",
  spec: { concurrency: 4, service: { policy: "fixed", mean: 0.01 }, ...spec },
});

function timelineOf(model: Timeline["model"], rate = 30): Timeline {
  return { model, load: [{ rate, duration: 600 }], seed: "render", mutations: [], bucketWidth: 0.25 };
}

const SHAPES: Array<{ name: string; timeline: Timeline; seconds: number }> = [
  {
    name: "a single component",
    timeline: timelineOf({ entryId: "only", nodes: [service("only")], edges: [] }),
    seconds: 8,
  },
  {
    name: "the demo system",
    timeline: demoTimeline(),
    seconds: 12,
  },
  {
    name: "a deep chain",
    timeline: timelineOf({
      entryId: "n0",
      nodes: Array.from({ length: 6 }, (_, i) => service(`n${i}`)),
      edges: Array.from({ length: 5 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
    }),
    seconds: 10,
  },
  {
    name: "a wide fan-out",
    timeline: timelineOf({
      entryId: "lb",
      nodes: [
        { id: "lb", kind: "balancer", spec: { balancer: { policy: "least-queue" } } },
        ...Array.from({ length: 6 }, (_, i) => service(`r${i}`)),
      ],
      edges: Array.from({ length: 6 }, (_, i) => ({ from: "lb", to: `r${i}` })),
    }),
    seconds: 10,
  },
  {
    name: "twenty components",
    timeline: timelineOf({
      entryId: "n0",
      nodes: Array.from({ length: 20 }, (_, i) => service(`n${i}`)),
      edges: Array.from({ length: 19 }, (_, i) => ({ from: `n${i}`, to: `n${i + 1}` })),
    }),
    seconds: 8,
  },
  {
    name: "a cache in front of a datastore",
    timeline: timelineOf({
      entryId: "cache",
      nodes: [
        {
          id: "cache",
          kind: "cache",
          spec: {
            concurrency: 40,
            service: { policy: "fixed", mean: 0.001 },
            cache: { policy: "fixed-ratio", hitRatio: 0.7 },
          },
        },
        {
          id: "db",
          kind: "datastore",
          spec: { concurrency: 2, service: { policy: "exponential", mean: 0.02 } },
        },
      ],
      edges: [{ from: "cache", to: "db" }],
    }),
    seconds: 10,
  },
  {
    name: "a shedding component under heavy overload",
    timeline: timelineOf(
      {
        entryId: "db",
        nodes: [
          {
            id: "db",
            kind: "datastore",
            spec: {
              concurrency: 1,
              service: { policy: "fixed", mean: 0.05 },
              queue: { policy: "drop-oldest", capacity: 3 },
            },
          },
        ],
        edges: [],
      },
      200,
    ),
    seconds: 10,
  },
  {
    name: "an empty model",
    timeline: { model: { entryId: null, nodes: [], edges: [] }, load: [], seed: "empty", mutations: [] },
    seconds: 4,
  },
  {
    name: "a frame taken before anything has run",
    timeline: timelineOf({ entryId: "only", nodes: [service("only")], edges: [] }),
    seconds: 0,
  },
];

describe("painting", () => {
  for (const shape of SHAPES) {
    it(`paints ${shape.name}`, async () => {
      const result = await render(shape.timeline, shape.seconds);

      expect(result.error ?? null, `${shape.name}: ${result.error}`).toBeNull();
      expect(result.ok).toBe(true);
    });
  }

  it("puts real pixels on the canvas rather than leaving it blank", async () => {
    await page.setContent(viewPage(bundle, JSON.stringify(demoTimeline()), 12));

    const distinctColours = await page.evaluate(() => {
      const canvas = document.querySelector("canvas") as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return seen.size;
    });

    // A blank canvas yields one colour; boxes, text, ribbons and gauges yield many.
    expect(distinctColours).toBeGreaterThan(20);
  });

  it("paints the overloaded state differently from the calm one", async () => {
    // Same model, two loads. If the two frames were pixel-identical the gauges
    // would be decoration.
    const fingerprint = async (rate: number): Promise<string> => {
      const timeline = timelineOf(
        {
          entryId: "db",
          nodes: [
            {
              id: "db",
              kind: "datastore",
              spec: {
                concurrency: 1,
                service: { policy: "exponential", mean: 0.02 },
                queue: { policy: "fifo", capacity: 25 },
              },
            },
          ],
          edges: [],
        },
        rate,
      );
      await page.setContent(viewPage(bundle, JSON.stringify(timeline), 20));
      return page.evaluate(() => {
        const canvas = document.querySelector("canvas") as HTMLCanvasElement;
        return canvas.toDataURL().slice(-2000);
      });
    };

    expect(await fingerprint(10)).not.toBe(await fingerprint(80));
  });
});
