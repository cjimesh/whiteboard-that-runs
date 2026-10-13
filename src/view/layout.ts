/**
 * Where the components sit on the canvas.
 *
 * Placement is derived from the wiring rather than stored, for now. The editor
 * (U6) will let an author drag components where they want them and record those
 * positions, but until then a model has no coordinates, and the live view still
 * has to be legible to a room — including for a twenty-component model nobody
 * arranged by hand.
 *
 * Layering by longest path from a source puts flow left to right, which matches
 * how the wiring is read aloud ("the balancer fans out to three services, they
 * all hit the one database"). Nodes are sized down as a layer fills up rather
 * than allowed to overlap: a cramped diagram is readable and an overlapping one
 * is not.
 *
 * The box is a fixed logical space that the renderer fits into whatever element
 * it has, so nothing here depends on the viewport — the same model produces the
 * same layout at any window size, which keeps captured frames comparable.
 */
import type { ModelSnapshot } from "../engine/timeline.ts";

export interface Box {
  width: number;
  height: number;
}

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  box: Box;
  /** Ranked left to right; index into `nodes` by id. */
  nodes: Record<string, Placement>;
}

/** The logical canvas. 16:9 because that is what a meeting-room screen is. */
export const LAYOUT_BOX: Box = { width: 1280, height: 720 };

const MARGIN = 56;
const MAX_NODE = { w: 210, h: 128 };
/** Comfortable smallest box — honoured while the canvas can afford it. */
const MIN_NODE = { w: 60, h: 38 };
const MIN_GAP = { x: 46, y: 22 };

/**
 * How far a small model may be blown up to fill the canvas.
 *
 * Node sizes are capped so a four-component model does not draw four slabs, but
 * the cap left the picture floating in the middle of a large screen with dead
 * space all round it — the model read as small even when the canvas was not. So
 * the finished layout is scaled up to fill the box it was given.
 *
 * Capped rather than unbounded because the renderer scales text along with
 * everything else: a two-node model would otherwise be drawn at four times size,
 * which stops looking like a diagram and starts looking like a mistake.
 */
const FILL_LIMIT = 1.6;

/**
 * Longest path from any source, per node.
 *
 * Iterated to a fixpoint with a hard cap rather than a topological sort, because
 * a cycle is a legal thing to draw — a retrying service calling something that
 * calls back is a real architecture — and a sort would either throw or silently
 * drop an edge. The cap means a cycle settles at a stable rank instead of looping.
 */
function rankNodes(model: ModelSnapshot): Map<string, number> {
  const ranks = new Map<string, number>();
  for (const node of model.nodes) ranks.set(node.id, 0);

  for (let pass = 0; pass < model.nodes.length; pass += 1) {
    let moved = false;
    for (const edge of model.edges) {
      const from = ranks.get(edge.from);
      const to = ranks.get(edge.to);
      if (from === undefined || to === undefined) continue;
      if (to < from + 1) {
        ranks.set(edge.to, from + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }

  return ranks;
}

export function layoutModel(model: ModelSnapshot, box: Box = LAYOUT_BOX): Layout {
  const nodes: Record<string, Placement> = {};
  if (model.nodes.length === 0) return { box, nodes };

  const ranks = rankNodes(model);
  const columns = new Map<number, string[]>();
  // Model order within a column, so a layout never reshuffles between frames.
  for (const node of model.nodes) {
    const rank = ranks.get(node.id) ?? 0;
    const column = columns.get(rank) ?? [];
    column.push(node.id);
    columns.set(rank, column);
  }

  const columnCount = Math.max(...columns.keys()) + 1;
  const tallest = Math.max(...[...columns.values()].map((column) => column.length));

  const usableWidth = box.width - 2 * MARGIN;
  const usableHeight = box.height - 2 * MARGIN;
  const cellWidth = usableWidth / columnCount;
  const cellHeight = usableHeight / tallest;

  // The floor yields to the cell rather than overriding it. A twenty-deep chain
  // gives each rank under 60px, and a floor that ignored that drew the boxes
  // through each other — an unreadable diagram claiming to be a readable one.
  // Below the comfortable minimum the nodes keep a proportional gap instead.
  const w = Math.min(MAX_NODE.w, Math.max(Math.min(MIN_NODE.w, cellWidth * 0.8), cellWidth - MIN_GAP.x));
  const h = Math.min(MAX_NODE.h, Math.max(Math.min(MIN_NODE.h, cellHeight * 0.8), cellHeight - MIN_GAP.y));

  for (const [rank, column] of columns) {
    // Each column is centred vertically on its own, so a three-way fan-out sits
    // symmetrically about the node feeding it rather than hanging from the top.
    const columnHeight = column.length * cellHeight;
    const top = MARGIN + (usableHeight - columnHeight) / 2;

    column.forEach((id, index) => {
      nodes[id] = {
        x: MARGIN + rank * cellWidth + (cellWidth - w) / 2,
        y: top + index * cellHeight + (cellHeight - h) / 2,
        w,
        h,
      };
    });
  }

  return { box, nodes: fillBox(nodes, box) };
}

/**
 * Grow the finished picture until it fills the canvas, keeping its proportions.
 *
 * A uniform scale about the content's own centre, so nothing that was clear of
 * its neighbour stops being clear of it. Only ever grows: shrinking to fit is
 * already handled by sizing nodes down as a column fills.
 */
function fillBox(nodes: Record<string, Placement>, box: Box): Record<string, Placement> {
  const places = Object.values(nodes);
  if (places.length === 0) return nodes;

  const minX = Math.min(...places.map((place) => place.x));
  const maxX = Math.max(...places.map((place) => place.x + place.w));
  const minY = Math.min(...places.map((place) => place.y));
  const maxY = Math.max(...places.map((place) => place.y + place.h));

  const contentWidth = maxX - minX;
  const contentHeight = maxY - minY;
  if (contentWidth <= 0 || contentHeight <= 0) return nodes;

  const scale = Math.min(
    FILL_LIMIT,
    Math.max(1, Math.min((box.width - 2 * MARGIN) / contentWidth, (box.height - 2 * MARGIN) / contentHeight)),
  );
  if (scale === 1) return nodes;

  const contentCentre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  const scaled: Record<string, Placement> = {};

  for (const [id, place] of Object.entries(nodes)) {
    const w = place.w * scale;
    const h = place.h * scale;
    const centreX = box.width / 2 + (place.x + place.w / 2 - contentCentre.x) * scale;
    const centreY = box.height / 2 + (place.y + place.h / 2 - contentCentre.y) * scale;
    scaled[id] = { x: centreX - w / 2, y: centreY - h / 2, w, h };
  }

  return scaled;
}

/** True if two placements share any area. Used by the layout tests. */
export function overlaps(a: Placement, b: Placement): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
