/**
 * The application: surfaces, and the transitions between them.
 *
 * A state machine over surfaces rather than a router. There is no URL to restore
 * — a model never leaves the page (R11) — and pretending otherwise would invite
 * exactly the sharing feature this version refuses.
 *
 * The outgoing surface is destroyed, not hidden. A hidden run surface keeps an
 * animation frame loop, a resize listener and a worker alive behind whatever is
 * in front of it, and the loop this exists to support — edit, run, edit again —
 * would leak one of each per pass. That lesson is inherited from the prior art,
 * where it was learned the expensive way.
 *
 * It opens on the running demo rather than on an empty editor. Somebody who was
 * sent this file should see a system running within a second of opening it; an
 * empty canvas asks them to do work before the tool has shown them anything.
 * The editor is one button away, and it opens on the demo as a document so the
 * first thing anybody edits is a system they have just watched fail.
 *
 * Nothing is kept for the author between visits, so closing the tab with work
 * nobody saved asks first. "Unsaved" means different from the last document that
 * was saved, opened, or freshly started; the demo as shipped has nothing to lose.
 */
import { createModelSimulation } from "../specs/registry.ts";
import { toTimeline, type WhiteboardDocument } from "../model/document.ts";
import { keepRunChanges, type RunChanges } from "../model/keep.ts";
import { controlsForDocument, type RunControls } from "./controls.ts";
import { demoControls, demoDocument, demoGuidance, demoTimeline } from "./demo.ts";
import { createEditorSurface, labelOf, whollyAssumed, type EditorSurface } from "./editor-surface.ts";
import { createRunSurface, type RunSurface } from "./run-surface.ts";
import type { Timeline } from "../engine/timeline.ts";
import type { ComparisonSpec } from "../verdict/study.ts";
import type { Guidance } from "./demo.ts";

/**
 * The document's comparison, as the run surface needs it.
 *
 * The two live on the document because they are things an author marks and saves;
 * they reach the run surface as a plain value because the run surface has no
 * business holding a document it cannot edit.
 */
function comparisonOf(document: WhiteboardDocument): ComparisonSpec {
  return { delta: document.delta, disputed: document.disputed };
}

export type SurfaceName = "run" | "editor";

export interface AppHandle {
  /** Which surface is mounted. What the tests read, rather than an internal flag. */
  surface(): SurfaceName | null;
  /** Whether closing the page now would lose edits nobody saved. */
  unsaved(): boolean;
  destroy(): void;
}

export function mountApp(root: HTMLElement): AppHandle {
  let current: RunSurface | EditorSurface | null = null;
  let editor: EditorSurface | null = null;
  let name: SurfaceName | null = null;
  /** What the editor opens on. The demo until somebody runs something else. */
  let editing: WhiteboardDocument = demoDocument();
  /** The last document with nothing to lose, compared by content. */
  let clean = JSON.stringify(editing);

  /**
   * The model as it was before the first "Keep these changes" since the editor was
   * last open, so the editor can offer one Undo back to it.
   */
  let beforeKeep: WhiteboardDocument | null = null;

  const unsaved = (): boolean => JSON.stringify(editor?.document() ?? editing) !== clean;
  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!unsaved()) return;
    event.preventDefault();
    // Older browsers only ask when this is set.
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  const showRun = (
    timeline: Timeline,
    controls: RunControls,
    comparison: ComparisonSpec,
    guidance?: Guidance,
    document?: WhiteboardDocument,
  ): void => {
    current?.destroy();
    editor = null;
    const sim = createModelSimulation(timeline);
    const surface = createRunSurface(sim, controls, {
      onEdit: () => showEditor(),
      // Only a run started from the editor can keep its changes. The opening demo
      // runs a hand-written timeline whose names are not the editable model's
      // (`api-1` there, `service-1` here), so what it kept would quietly miss.
      ...(document === undefined
        ? {}
        : {
            onKeep: (changes: RunChanges) => {
              beforeKeep ??= editing;
              editing = keepRunChanges(editing, changes);
            },
          }),
      comparison,
      ...(guidance === undefined ? {} : { guidance }),
      // What the author called things, and which numbers are still guesses — said
      // on the boxes in the room as they were in the editor.
      ...(document === undefined
        ? {}
        : {
            labels: new Map(document.components.map((component) => [component.id, labelOf(component)])),
            assumed: whollyAssumed(document),
          }),
    });
    current = surface;
    name = "run";
    root.replaceChildren(surface.element);
    // Started after mounting: the canvas sizes itself from its layout box.
    surface.start();
  };

  const showEditor = (): void => {
    current?.destroy();
    const undoTo = beforeKeep !== null && beforeKeep !== editing ? beforeKeep : undefined;
    beforeKeep = null;
    const surface = createEditorSurface({
      document: editing,
      ...(undoTo === undefined ? {} : { undoTo }),
      onRun: (document) => {
        // Kept so leaving the run surface returns to the model as authored,
        // rather than to whatever was open before it.
        editing = document;
        showRun(toTimeline(document), controlsForDocument(document), comparisonOf(document), undefined, document);
      },
      onClean: (document) => {
        clean = JSON.stringify(document);
      },
    });
    current = surface;
    editor = surface;
    name = "editor";
    root.replaceChildren(surface.element);
    surface.start();
  };

  // The tour rides with the demo and only with the demo: a model somebody
  // authored needs no explanation of itself.
  showRun(demoTimeline(), demoControls(), comparisonOf(demoDocument()), demoGuidance());

  return {
    surface: () => (current === null ? null : name),
    unsaved,
    destroy() {
      window.removeEventListener("beforeunload", onBeforeUnload);
      current?.destroy();
      editor = null;
      current = null;
      name = null;
      root.replaceChildren();
    },
  };
}
