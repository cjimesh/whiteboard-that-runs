/**
 * The compute worker: long simulation work, off the thread that paints.
 *
 * The validation suite is around 9 million completions and takes tens of
 * seconds. Run on the main thread it would not be slow, it would be a frozen
 * tab — no animation, no clicks, not even a spinner, since a spinner needs the
 * thread that is busy. The breaking-point sweep (U7) has the same shape and
 * belongs here too, which is why this is a general compute worker rather than a
 * validation one.
 *
 * It is bundled with `?worker&inline`, so its code ends up inside the single
 * HTML file and starts from a `blob:` URL instead of a network fetch. That keeps
 * the one-file, zero-egress promise intact, and is why the pinned CSP carries
 * `worker-src blob:`.
 */
import { runValidation } from "../validation/harness.ts";
import { STANDARD_CHECKS } from "../validation/harness.ts";
import { runStudy } from "../verdict/study.ts";
import type { ComputeRequest, ComputeResponse } from "./protocol.ts";

/**
 * The worker global, typed to what is actually used.
 *
 * Declared locally rather than by adding the WebWorker lib to tsconfig, which
 * would collide with the DOM lib the rest of the app needs.
 */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const send = (response: ComputeResponse): void => scope.postMessage(response);

const totalPoints = STANDARD_CHECKS.reduce((count, check) => count + check.points.length, 0);

scope.addEventListener("message", (event) => {
  const request = event.data as ComputeRequest;

  try {
    switch (request.kind) {
      case "validate": {
        let index = 0;
        const report = runValidation({
          onPoint(point, check) {
            index += 1;
            send({ kind: "point", check, point, index, total: totalPoints });
          },
        });
        send({ kind: "done", report });
        break;
      }
      case "study": {
        const study = runStudy(request.target, request.comparison, {
          onProbe: (arm, probe, index, maxProbes) => send({ kind: "probe", arm, probe, index, maxProbes }),
        });
        send({ kind: "studied", study });
        break;
      }
      default:
        send({ kind: "error", message: `unknown request "${String((request as { kind: string }).kind)}"` });
    }
  } catch (error) {
    // Reported rather than thrown: an uncaught worker error surfaces as a bare
    // "error" event with no message in most browsers, and the panel has a state
    // for a failure it can describe.
    send({ kind: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
