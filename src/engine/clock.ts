/**
 * The simulation clock.
 *
 * Sim time, measured in seconds, is the only time the engine knows about. Wall
 * time exists exactly once, in the paced driver, where a frame delta is
 * converted into a sim-time advance and then forgotten — nothing downstream can
 * observe how long a frame took, which is what lets a run recorded live replay
 * headless and land on the same numbers.
 *
 * Monotonicity is enforced rather than assumed. An event that tries to fire
 * before now means the schedule was built with a negative delay somewhere, and
 * that bug is far cheaper to find here than to debug later as a replay that
 * mysteriously disagrees with its original.
 */
export interface SimClock {
  now(): number;
  /** Move to `time`. Throws if that would run the clock backwards. */
  set(time: number): void;
}

export function createClock(start = 0): SimClock {
  let current = start;

  return {
    now: () => current,
    set(time) {
      if (time < current) {
        throw new Error(
          `simulation clock cannot run backwards: asked for ${time} while at ${current}`,
        );
      }
      current = time;
    },
  };
}
