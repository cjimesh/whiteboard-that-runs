/**
 * The validation panel (R13): the textbook curve, and this simulator reproducing it.
 *
 * The argument it exists to win is a specific one. Someone in the room says "how
 * do I know your simulator is right?", and the answer has to be better than
 * assurance. This runs the same closed-form checks the test suite runs, at the
 * same declared budget, live, while they watch — M/M/1 against 1/(μ−λ), M/M/c
 * against Erlang C, Little's Law per node.
 *
 * Rows fill in as points land rather than appearing all at once, because the
 * work takes tens of seconds and a blank panel with a spinner is indistinguishable
 * from a hang. Watching it grind through nine points is also, quietly, part of the
 * argument: it visibly is not a lookup table.
 *
 * When no worker is available the panel says so and offers the run anyway, with
 * the freeze stated. Running a smaller, quicker version instead would be the one
 * unacceptable option — the panel's whole worth is that it is the same check.
 */
import { formatReport, runValidation, type PointResult, type ValidationReport } from "../validation/harness.ts";
import { createComputeClient, type ComputeClient } from "../worker/client.ts";
import type { ComputeResponse } from "../worker/protocol.ts";

export interface ValidationPanel {
  element: HTMLElement;
  destroy(): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function pointRow(point: PointResult, checkName: string): HTMLElement {
  const row = element("tr", point.ok ? "wtr-row-ok" : "wtr-row-fail");
  row.dataset["point"] = point.label;

  const cells = [
    `${checkName.split("—")[0]?.trim() ?? ""} ${point.label}`,
    point.measured.sojourn.toFixed(4),
    point.expected.sojourn.toFixed(4),
    `${(point.error * 100).toFixed(2)}%`,
    `±${(point.tolerance * 100).toFixed(0)}%`,
    point.ok ? "pass" : "FAIL",
  ];

  for (const [index, text] of cells.entries()) {
    const cell = element("td", index === 0 ? "wtr-cell-label" : undefined, text);
    row.append(cell);
  }

  if (point.toleranceNote !== undefined) {
    row.title = point.toleranceNote;
  }
  return row;
}

export function createValidationPanel(): ValidationPanel {
  const root = element("section", "wtr-validation");
  root.dataset["panel"] = "validation";

  const heading = element("h2", "wtr-validation-title", "Does the simulator agree with the textbook?");
  const blurb = element(
    "p",
    "wtr-validation-blurb",
    "The same checks the test suite runs, at the same declared budget, run here now. " +
      "Closed-form queueing results the simulator has no knowledge of.",
  );

  const status = element("p", "wtr-validation-status", "Starting…");
  status.dataset["state"] = "running";

  const table = element("table", "wtr-validation-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["Check", "Measured W", "Theory W", "Error", "Allowed", ""]) {
    headRow.append(element("th", undefined, label));
  }
  head.append(headRow);
  const body = element("tbody");
  table.append(head, body);

  const footer = element("p", "wtr-validation-footer");

  root.append(heading, blurb, status, table, footer);

  let client: ComputeClient | null = null;
  let destroyed = false;

  const finish = (report: ValidationReport): void => {
    if (destroyed) return;
    status.dataset["state"] = report.ok ? "pass" : "fail";
    status.textContent = report.ok
      ? "Every check passed."
      : "At least one check missed its band — see the rows marked FAIL.";
    footer.textContent =
      `Seed ${report.seed} · ${Math.round(report.totals.simSeconds).toLocaleString("en-US")} simulated seconds · ` +
      `${report.totals.completions.toLocaleString("en-US")} completed requests`;
    root.dataset["result"] = report.ok ? "pass" : "fail";
  };

  const addPoint = (point: PointResult, checkName: string, index: number, total: number): void => {
    if (destroyed) return;
    body.append(pointRow(point, checkName));
    status.textContent = `Running… ${index} of ${total} points`;
  };

  const fail = (message: string): void => {
    if (destroyed) return;
    status.dataset["state"] = "error";
    status.textContent = `The checks could not run: ${message}`;
    root.dataset["result"] = "error";
  };

  /** The fallback when this browser will not give us a worker. */
  const offerMainThreadRun = (reason: string): void => {
    status.dataset["state"] = "blocked";
    status.textContent =
      `No background thread available here (${reason}). The checks can still run, but they will ` +
      "lock the page up for around half a minute while they do.";

    const run = element("button", "wtr-button", "Run anyway (freezes the page)");
    run.type = "button";
    run.dataset["action"] = "validate-blocking";
    run.addEventListener("click", () => {
      run.remove();
      status.textContent = "Running on the main thread — the page will not respond until this finishes.";
      // Deferred a frame so the message above actually paints before the thread
      // is taken away. Without this the user sees nothing until it is over.
      globalThis.requestAnimationFrame(() => {
        globalThis.requestAnimationFrame(() => {
          try {
            let index = 0;
            const report = runValidation({
              onPoint: (point, checkName) => {
                index += 1;
                addPoint(point, checkName, index, index);
              },
            });
            finish(report);
          } catch (error) {
            fail(error instanceof Error ? error.message : String(error));
          }
        });
      });
    });
    root.append(run);
  };

  const availability = createComputeClient({
    onMessage(response: ComputeResponse) {
      switch (response.kind) {
        case "point":
          addPoint(response.point, response.check, response.index, response.total);
          break;
        case "done":
          finish(response.report);
          break;
        case "error":
          fail(response.message);
          break;
      }
    },
  });

  if (availability.client === null) {
    offerMainThreadRun(availability.reason ?? "workers are not permitted here");
  } else {
    client = availability.client;
    client.send({ kind: "validate" });
  }

  return {
    element: root,
    destroy() {
      destroyed = true;
      client?.destroy();
      client = null;
    },
  };
}

/** Text form of a report, for capture scripts and failure messages. */
export { formatReport };
