/**
 * Shapes to start from, instead of a blank canvas.
 *
 * The first box and the first wire are the steepest part of using this: until
 * something runs, an author is learning a vocabulary with nothing to show for it.
 * Most designs argued about in a review are one of a handful of shapes, so the
 * editor offers those, already running, and the author changes the numbers and
 * the names. A blank canvas stays one choice among them.
 *
 * Every shape is built with the same document operations an author uses, from
 * the palette's archetypes, so a shape can never be something the editor could
 * not have produced by hand.
 */
import { addArchetype } from "../model/archetypes.ts";
import { connect, emptyDocument, setLoad, setSpec, type WhiteboardDocument } from "../model/document.ts";
import { demoDocument } from "./demo.ts";

export interface StartingShape {
  readonly id: string;
  readonly label: string;
  readonly blurb: string;
  build(): WhiteboardDocument;
}

/** What the editor does when an arrow is set to "Passes the request on, and moves on". */
function handsOffWithoutWaiting(document: WhiteboardDocument, id: string): WhiteboardDocument {
  const component = document.components.find((candidate) => candidate.id === id);
  const spec = { ...component?.spec, downstream: { policy: "fire-and-forget" as const } };
  const next = setSpec(document, id, spec);
  return {
    ...next,
    components: next.components.map((candidate) => (candidate.id === id ? { ...candidate, preset: null } : candidate)),
  };
}

function withLoad(document: WhiteboardDocument, rate: number): WhiteboardDocument {
  return setLoad(document, [{ rate, duration: 3600 }]);
}

export const STARTING_SHAPES: readonly StartingShape[] = [
  {
    id: "web-database",
    label: "App servers and a database",
    blurb: "A load balancer, two app servers, one database they both use.",
    build() {
      let doc = emptyDocument("App servers and a database");
      for (const kind of ["balancer", "app", "app", "database"]) doc = addArchetype(doc, kind).document;
      doc = connect(doc, "lb-1", "app-1");
      doc = connect(doc, "lb-1", "app-2");
      doc = connect(doc, "app-1", "db-1");
      doc = connect(doc, "app-2", "db-1");
      return withLoad(doc, 100);
    },
  },
  {
    id: "cache",
    label: "A cache in front of a database",
    blurb: "An app server that reads through a cache; misses go on to the database.",
    build() {
      let doc = emptyDocument("A cache in front of a database");
      for (const kind of ["app", "cache", "database"]) doc = addArchetype(doc, kind).document;
      doc = connect(doc, "app-1", "cache-1");
      doc = connect(doc, "cache-1", "db-1");
      return withLoad(doc, 200);
    },
  },
  {
    id: "shared-store",
    label: "App servers sharing an in-memory store",
    blurb: "Two app servers that each ask one in-memory store a few times per request.",
    build() {
      let doc = emptyDocument("App servers sharing an in-memory store");
      for (const kind of ["balancer", "app", "app", "database", "memory-store"]) doc = addArchetype(doc, kind).document;
      doc = connect(doc, "lb-1", "app-1");
      doc = connect(doc, "lb-1", "app-2");
      doc = connect(doc, "app-1", "db-1");
      doc = connect(doc, "app-2", "db-1");
      doc = connect(doc, "app-1", "store-1", "call");
      doc = connect(doc, "app-2", "store-1", "call");
      return withLoad(doc, 100);
    },
  },
  {
    id: "queue",
    label: "A queue and workers",
    blurb: "An app server that hands work to a queue; workers take it off and write to a database.",
    build() {
      let doc = emptyDocument("A queue and workers");
      for (const kind of ["app", "queue", "app", "database"]) doc = addArchetype(doc, kind).document;
      doc = connect(doc, "app-1", "queue-1");
      doc = handsOffWithoutWaiting(doc, "app-1");
      doc = connect(doc, "queue-1", "app-2");
      doc = connect(doc, "app-2", "db-1");
      return withLoad(doc, 50);
    },
  },
  {
    id: "demo",
    label: "The retry-storm demo",
    blurb: "The model the tool opens on: two app servers retrying against one slow database.",
    build: demoDocument,
  },
  {
    id: "blank",
    label: "Blank canvas",
    blurb: "Nothing on it. Add components from the palette.",
    build: () => emptyDocument(),
  },
];
