/**
 * The transport: an animation frame loop that advances the simulation clock.
 *
 * Lifted from the prior art's player, with one substitution that matters. There
 * the loop accumulated progress towards a fixed duration; here it converts each
 * frame's wall-clock delta into sim seconds and hands them to the engine. That is
 * the only place in the codebase where wall time touches sim time, and it is
 * one-way: the engine is told how far to advance and can never observe how long
 * the frame took, which is what keeps a run watched live identical to the same
 * run replayed headless.
 *
 * There is no scrubber and no seek. Sim time only moves forward — the engine
 * refuses to run its clock backwards — and a live model is a thing you are
 * steering rather than a recording you are reviewing. Rewinding would mean
 * re-running from a recorded timeline, which is replay, a different mode.
 */
import type { Simulation } from "../engine/kernel.ts";

export interface Player {
  play(): void;
  pause(): void;
  isPlaying(): boolean;
  /** Sim seconds per wall second. */
  rate(): number;
  setRate(rate: number): void;
  /** Repaint without advancing. Used on resize and after a live change while paused. */
  repaint(): void;
  destroy(): void;
}

export interface PlayerOptions {
  sim: Simulation;
  /** Called after every advance, and once on construction. */
  onFrame: () => void;
  rate?: number;
  /**
   * Largest sim-time step a single frame may take.
   *
   * A backgrounded tab delivers one enormous delta on return; without a clamp
   * that would drain minutes of simulation in one blocking chunk and the page
   * would appear to hang. Capping loses sim time rather than responsiveness,
   * which is the right trade for a live view — the recorded timeline is what
   * anything reproducible reads from.
   */
  maxStep?: number;
}

const DEFAULT_MAX_STEP = 0.25;

export function createPlayer(options: PlayerOptions): Player {
  const { sim, onFrame } = options;
  const maxStep = options.maxStep ?? DEFAULT_MAX_STEP;

  let rate = options.rate ?? 1;
  let playing = false;
  let handle = 0;
  let last = 0;

  const tick = (now: number): void => {
    if (!playing) return;
    const deltaMs = last === 0 ? 0 : now - last;
    last = now;

    const step = Math.min(maxStep, (deltaMs / 1000) * rate);
    if (step > 0) sim.advance(step);

    onFrame();
    if (playing) handle = globalThis.requestAnimationFrame(tick);
  };

  onFrame();

  return {
    play() {
      if (playing) return;
      playing = true;
      last = 0;
      handle = globalThis.requestAnimationFrame(tick);
    },

    pause() {
      playing = false;
      globalThis.cancelAnimationFrame(handle);
      // Paint once on the way out so the frozen frame reflects the final advance
      // rather than whatever the last tick happened to leave.
      onFrame();
    },

    isPlaying: () => playing,
    rate: () => rate,

    setRate(next) {
      rate = Math.min(16, Math.max(0.1, next));
    },

    repaint() {
      onFrame();
    },

    destroy() {
      playing = false;
      globalThis.cancelAnimationFrame(handle);
    },
  };
}
