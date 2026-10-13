import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FILE_FORMAT, FILE_VERSION, parse, serialize, suggestedFilename } from "./persist.ts";
import {
  addComponent,
  addTrafficSource,
  connect,
  emptyDocument,
  setDisputed,
  setLoad,
  setProposal,
  setSpec,
  validateDocument,
  type WhiteboardDocument,
} from "./document.ts";

function lastMonthsSystem(): WhiteboardDocument {
  let doc = emptyDocument("Orders platform");
  doc = addComponent(doc, { kind: "balancer", preset: "balancer/round-robin" }).document;
  doc = addComponent(doc, { kind: "service", preset: "service/exponential-retry" }).document;
  doc = addComponent(doc, { kind: "datastore", preset: "datastore/single-connection" }).document;
  doc = connect(doc, "balancer-1", "service-1");
  doc = connect(doc, "service-1", "datastore-1");
  doc = setSpec(doc, "datastore-1", { concurrency: 1, service: { policy: "exponential", mean: 0.02 } });
  return setLoad(doc, [
    { rate: 200, duration: 120 },
    { rate: 800, duration: 30 },
    { rate: 200, duration: 120 },
  ]);
}

describe("the monthly loop (AE4)", () => {
  it("reopens as exactly what was saved", () => {
    const before = lastMonthsSystem();
    const result = parse(serialize(before));

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.document).toEqual(before);
  });

  it("survives a second round trip byte for byte", () => {
    const once = serialize(lastMonthsSystem());
    const result = parse(once);
    expect(result.ok === true && serialize(result.document)).toBe(once);
  });

  it("keeps the load pattern, which is half of what makes last month's model reusable", () => {
    const result = parse(serialize(lastMonthsSystem()));
    expect(result.ok === true && result.document.load).toEqual([
      { rate: 200, duration: 120 },
      { rate: 800, duration: 30 },
      { rate: 200, duration: 120 },
    ]);
  });

  it("lets this month's component be added without touching the existing system", () => {
    const reopened = parse(serialize(lastMonthsSystem()));
    if (!reopened.ok) throw new Error("expected a readable file");

    const before = reopened.document;
    const added = addComponent(before, { kind: "cache", preset: "cache/warm" });
    const withCache = connect(added.document, "service-1", "cache-1");

    // Every pre-existing component and wire is identical — only the new one and
    // its wire appear. This is the claim AE4 makes, and it is the reason the
    // document is rebuilt rather than mutated.
    expect(withCache.components.slice(0, 3)).toEqual(before.components);
    expect(withCache.edges.slice(0, before.edges.length)).toEqual(before.edges);
    expect(withCache.load).toEqual(before.load);
    expect(withCache.entryId).toBe(before.entryId);
  });
});

describe("opening something that is not a model", () => {
  const errorFor = (text: string): string => {
    const result = parse(text);
    if (result.ok) throw new Error("expected a refusal");
    return result.error;
  };

  it("refuses text that is not JSON", () => {
    expect(errorFor("this is my model, honest")).toMatch(/not JSON/i);
  });

  it("refuses JSON that is not one of ours", () => {
    expect(errorFor(JSON.stringify({ nodes: [], edges: [] }))).toMatch(/not a whiteboard model file/i);
  });

  it("refuses a file from a newer version, and says so", () => {
    const future = JSON.stringify({ format: FILE_FORMAT, version: FILE_VERSION + 1, document: {} });
    expect(errorFor(future)).toMatch(/newer version/i);
  });

  it("names the component it could not read", () => {
    const file = JSON.stringify({
      format: FILE_FORMAT,
      version: FILE_VERSION,
      document: {
        components: [{ id: "api", kind: "quantum-mesh" }],
        edges: [],
        load: [{ rate: 1, duration: 1 }],
      },
    });
    expect(errorFor(file)).toMatch(/"api" has an unknown kind "quantum-mesh"/);
  });

  it("names a wire it could not read", () => {
    const file = JSON.stringify({
      format: FILE_FORMAT,
      version: FILE_VERSION,
      document: { components: [], edges: [{ from: "a" }], load: [] },
    });
    expect(errorFor(file)).toMatch(/wire 1 has no ends/);
  });

  it("refuses a truncated file rather than loading half a model", () => {
    const half = serialize(lastMonthsSystem()).slice(0, 120);
    expect(errorFor(half)).toMatch(/not JSON/i);
  });
});

describe("what a saved file is allowed to be", () => {
  it("reopens a half-finished model rather than refusing it", () => {
    // Schema, not runnability: an author saving at the end of a session has not
    // necessarily wired everything, and a loader that demanded a runnable model
    // would make saving something they have to earn.
    let doc = emptyDocument("half done");
    doc = addComponent(doc, { kind: "service" }).document;
    doc = addComponent(doc, { kind: "datastore" }).document;

    const result = parse(serialize(doc));
    expect(result.ok).toBe(true);
    // It reopens, and it is the *editor* that says what is still missing.
    expect(validateDocument(result.ok === true ? result.document : doc).ok).toBe(false);
  });

  it("fills in fields an older file never had", () => {
    const old = JSON.stringify({
      format: FILE_FORMAT,
      version: 1,
      document: { components: [], edges: [], load: [{ rate: 5, duration: 10 }] },
    });
    const result = parse(old);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.seed).toBe(emptyDocument().seed);
    expect(result.document.bucketWidth).toBe(emptyDocument().bucketWidth);
    expect(result.document.entryId).toBeNull();
  });
});

describe("the filename", () => {
  it("is one the author will recognise a month later", () => {
    expect(suggestedFilename(emptyDocument("Orders platform"))).toBe("orders-platform.whiteboard.json");
  });

  it("never produces a nameless file", () => {
    expect(suggestedFilename(emptyDocument("   "))).toBe("model.whiteboard.json");
    expect(suggestedFilename(emptyDocument("///"))).toBe("model.whiteboard.json");
  });
});


describe("a comparison survives the round trip", () => {
  it("keeps the proposal marks and the disputed range", () => {
    // R4's monthly loop is the reason: last month's model reopens with this
    // month's proposal still marked, or the comparison has to be set up again
    // every time — which is how it stops being used.
    let before = setProposal(lastMonthsSystem(), "datastore-1", true);
    before = setDisputed(before, { componentId: "datastore-1", field: "capacity", min: 40, max: 60 });

    const after = parse(serialize(before));

    expect(after.ok).toBe(true);
    expect(after.ok && after.document).toEqual(before);
  });

  it("opens a file saved before either existed", () => {
    // Both arrived after version 1 of the format. A file without them is a work
    // in progress with nothing marked, not a file to refuse.
    const older = JSON.parse(serialize(lastMonthsSystem())) as { document: Record<string, unknown> };
    delete older.document["delta"];
    delete older.document["disputed"];

    const after = parse(JSON.stringify(older));

    expect(after.ok).toBe(true);
    expect(after.ok && after.document.delta).toEqual([]);
    expect(after.ok && after.document.disputed).toBeNull();
  });

  it("leaves a mark pointing at nothing for the editor to complain about", () => {
    // Schema, not runnability: the file loads and `validateDocument` says what is
    // wrong, next to the model it is wrong about.
    const file = JSON.parse(serialize(lastMonthsSystem())) as { document: Record<string, unknown> };
    file.document["delta"] = ["ghost"];

    const after = parse(JSON.stringify(file));

    expect(after.ok).toBe(true);
    expect(after.ok && validateDocument(after.document).ok).toBe(false);
  });
});


describe("the demo, as a file somebody can open", () => {
  /**
   * `fixtures/demo-system.json` exists so the demo is a model and not only a
   * screen: it can be opened in the editor, committed next to a design doc, or
   * sent to somebody. Which means it can also fall out of step with the code that
   * produces it, and a stale fixture that still loads is the worst kind — it
   * would quietly hand somebody last month's demo.
   */
  it("is exactly the demo the app runs", async () => {
    const { demoDocument } = await import("../ui/demo.ts");
    const onDisk = parse(readFileSync("fixtures/demo-system.json", "utf8"));

    expect(onDisk.ok).toBe(true);
    expect(onDisk.ok && onDisk.document).toEqual(demoDocument());
  });

  it("is runnable, not just readable", () => {
    const onDisk = parse(readFileSync("fixtures/demo-system.json", "utf8"));

    expect(onDisk.ok && validateDocument(onDisk.document).errors).toEqual([]);
  });
});

describe("other traffic survives the round trip", () => {
  it("reopens with the rate that was saved", () => {
    const { document } = addTrafficSource(lastMonthsSystem(), "datastore-1", 35);
    const result = parse(serialize(document));
    expect(result.ok === true && result.document.sources).toEqual(document.sources);
  });

  it("opens a file saved before other traffic existed, with none", () => {
    // Schema, not runnability: a key this build added cannot make last month's
    // model unopenable.
    const saved = JSON.parse(serialize(lastMonthsSystem())) as { document: Record<string, unknown> };
    delete saved.document["sources"];

    const result = parse(JSON.stringify(saved));
    expect(result.ok === true && result.document.sources).toEqual([]);
  });

  it("keeps other traffic that points at nothing, for the editor to complain about", () => {
    // Refusing the file would replace the author's work with nothing. The
    // editor can say which component it means; the parser cannot.
    const { document } = addTrafficSource(lastMonthsSystem(), "datastore-1", 35);
    const saved = JSON.parse(serialize(document)) as { document: { sources: { nodeId: string }[] } };
    saved.document.sources[0]!.nodeId = "ghost";

    const result = parse(JSON.stringify(saved));
    expect(result.ok).toBe(true);
    expect(result.ok === true && validateDocument(result.document).errors.join(" ")).toMatch(
      /"ghost", which is not in this model/,
    );
  });
});
