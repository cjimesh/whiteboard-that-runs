/**
 * The timeout, in the unit people say it in.
 *
 * Same shape as `capacity.ts` and for the same reason: the spec stores seconds
 * because the engine works in sim seconds, and every human sentence about a
 * timeout is in milliseconds ("we give it 250 ms"). This converts, and nothing
 * else moves.
 *
 * It earns its own knob because of what it does in a system with retries, which
 * a session with this model made concrete: at 40 req/s against a 50/s datastore,
 * a 250 ms timeout collapses the design to zero goodput while a 1 s timeout
 * carries all 40. The timeout is not a safety margin in that design, it is the
 * trigger — it decides how often a slow answer becomes a *second* request, and a
 * caller that gives up does not stop the work it abandoned. Nothing else in the
 * palette moves that outcome as cheaply, and until now it was the one parameter
 * of the demo's failure that could not be reached from the page.
 */
import { CONCERNS, resolveSpec, type ComponentKind, type PartialComponentSpec, type TimeoutPolicy } from "./format.ts";

export interface TimeoutReading {
  policy: TimeoutPolicy;
  /** The configured duration, whether or not the policy is currently using it. */
  milliseconds: number;
}

/** Whether a kind calls something and waits, and so has a timeout to state. */
export function hasTimeout(kind: ComponentKind): boolean {
  return CONCERNS[kind].includes("timeout");
}

export function timeoutOf(kind: ComponentKind, spec: PartialComponentSpec): TimeoutReading | null {
  if (!hasTimeout(kind)) return null;
  const resolved = resolveSpec(kind, spec);
  return { policy: resolved.timeout.policy, milliseconds: resolved.timeout.after * 1000 };
}

/**
 * Set the timeout. `null` switches it off.
 *
 * Switching off keeps the duration on the spec rather than zeroing it, because
 * the format carries every policy's parameters precisely so that flipping a
 * policy live never has to invent a value in front of a room.
 */
export function withTimeout(
  kind: ComponentKind,
  spec: PartialComponentSpec,
  milliseconds: number | null,
): PartialComponentSpec {
  if (!hasTimeout(kind)) {
    throw new Error(`a ${kind} does not wait on anything, so it has no timeout to set`);
  }

  const current = resolveSpec(kind, spec).timeout;
  if (milliseconds === null) {
    return { ...spec, timeout: { policy: "none", after: current.after } };
  }
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(`a timeout must be a positive, finite number of milliseconds, got ${milliseconds}`);
  }
  return { ...spec, timeout: { policy: "fixed", after: milliseconds / 1000 } };
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 1000) return `${Number((milliseconds / 1000).toFixed(2))} s`;
  return `${Number(milliseconds.toFixed(2))} ms`;
}

/**
 * What the setting does, not merely what it is.
 *
 * "250 ms" is a fact; "gives up on a slow call after 250 ms, then retries" is the
 * behaviour, and the behaviour is what somebody is deciding about.
 */
export function describeTimeout(reading: TimeoutReading): string {
  if (reading.policy === "none") return "Never gives up: waits as long as the call takes.";
  return `Gives up on a slow call after ${formatDuration(reading.milliseconds)}, then retries.`;
}

export type TimeoutInput = { ok: true; milliseconds: number | null } | { ok: false; error: string };

export function parseTimeout(text: string): TimeoutInput {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Enter a timeout in milliseconds, for example 250, or 'off'." };
  if (/^(off|none|never)$/i.test(trimmed)) return { ok: true, milliseconds: null };

  const match = /^([0-9]*\.?[0-9]+)\s*(ms|millisecond?s?|s|sec|secs|seconds?)?$/i.exec(trimmed);
  if (match === null) {
    return { ok: false, error: `"${trimmed}" is not a duration. Enter milliseconds, for example 250, or 'off'.` };
  }

  const value = Number(match[1]);
  const seconds = /^s/i.test(match[2] ?? "");
  const milliseconds = seconds ? value * 1000 : value;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return { ok: false, error: "A timeout has to be greater than zero. Use 'off' to remove it." };
  }
  return { ok: true, milliseconds };
}
