/**
 * Starting the compute worker, and coping when it cannot start.
 *
 * The second half is not defensive padding. The shipped artifact is one HTML file
 * meant to be opened straight off disk, and a `file://` page has an opaque
 * origin where a browser may refuse to construct a worker from a `blob:` URL.
 * Whether that is true is settled by the build test rather than assumed here —
 * but the page has to behave either way, because "double-click the file" is the
 * distribution channel.
 *
 * So this reports honestly instead of throwing. When there is no worker, the
 * caller can offer the work on the main thread with the freeze stated plainly,
 * which is a real choice a person can make. Silently running a cheaper version
 * would not be: the validation panel's whole worth is that it runs the same
 * checks the test suite does.
 */
import ComputeWorker from "./compute.ts?worker&inline";
import type { ComputeRequest, ComputeResponse } from "./protocol.ts";

export interface ComputeHandlers {
  onMessage(response: ComputeResponse): void;
}

export interface ComputeClient {
  send(request: ComputeRequest): void;
  destroy(): void;
}

export interface ComputeAvailability {
  /** Non-null when a worker started; null when this environment refused one. */
  client: ComputeClient | null;
  /** Why there is no worker, for the panel to show rather than swallow. */
  reason?: string;
}

export function createComputeClient(handlers: ComputeHandlers): ComputeAvailability {
  let worker: Worker;
  try {
    worker = new ComputeWorker();
  } catch (error) {
    return {
      client: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  worker.addEventListener("message", (event: MessageEvent) => {
    handlers.onMessage(event.data as ComputeResponse);
  });

  worker.addEventListener("error", (event: ErrorEvent) => {
    handlers.onMessage({
      kind: "error",
      message: event.message || "the background worker stopped without saying why",
    });
  });

  return {
    client: {
      send: (request) => worker.postMessage(request),
      destroy: () => worker.terminate(),
    },
  };
}
