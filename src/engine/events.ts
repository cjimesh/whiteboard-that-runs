/**
 * The event queue: a binary heap ordered by (time, priority, sequence).
 *
 * Two events stamped at the same sim time have to fire in a defined order or
 * replay is a lie, and "whatever the heap happens to do" is not a defined
 * order — sift order depends on insertion history, so the same timeline could
 * settle differently after an unrelated change. Hence the two tiebreakers.
 *
 * `priority` is the semantic rule (below). `sequence` is insertion order, which
 * makes the ordering total: two mutations recorded at the same instant apply in
 * the order the operator made them.
 */

/**
 * Ordering of events that land on the same instant. Lower fires first.
 *
 * The rule reads: *close the books, finish what is in flight, then let the
 * operator's change take effect, then admit new work under it.*
 *
 *   BUCKET first, so a metrics window is the half-open interval [start, end)
 *   and an event stamped exactly on a boundary belongs to the window it opens.
 *
 *   SERVICE settles before MUTATION so that work already in service completes
 *   under the parameters it started with. Retroactively re-timing in-flight
 *   work would mean a slider drag could change the past, and R7's "takes effect
 *   immediately" means from now on, not from the beginning.
 *
 *   ARRIVAL last, so a job admitted at the same instant as a change is admitted
 *   under the new parameters — which is the direction an operator expects.
 */
export const EventPriority = {
  BUCKET: 0,
  SERVICE: 1,
  MUTATION: 2,
  ARRIVAL: 3,
} as const;

export type EventPriorityValue = (typeof EventPriority)[keyof typeof EventPriority];

export interface ScheduledEvent {
  readonly time: number;
  readonly priority: EventPriorityValue;
  readonly sequence: number;
  readonly run: () => void;
}

function precedes(a: ScheduledEvent, b: ScheduledEvent): boolean {
  if (a.time !== b.time) return a.time < b.time;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.sequence < b.sequence;
}

export interface EventQueue {
  push(time: number, priority: EventPriorityValue, run: () => void): void;
  /** The earliest event's time, or `undefined` when the queue is empty. */
  peekTime(): number | undefined;
  pop(): ScheduledEvent | undefined;
  size(): number;
}

export function createEventQueue(): EventQueue {
  const heap: ScheduledEvent[] = [];
  let sequence = 0;

  const swap = (i: number, j: number): void => {
    const a = heap[i] as ScheduledEvent;
    heap[i] = heap[j] as ScheduledEvent;
    heap[j] = a;
  };

  const siftUp = (from: number): void => {
    let index = from;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!precedes(heap[index] as ScheduledEvent, heap[parent] as ScheduledEvent)) break;
      swap(index, parent);
      index = parent;
    }
  };

  const siftDown = (from: number): void => {
    let index = from;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;
      if (left < heap.length && precedes(heap[left] as ScheduledEvent, heap[best] as ScheduledEvent)) {
        best = left;
      }
      if (right < heap.length && precedes(heap[right] as ScheduledEvent, heap[best] as ScheduledEvent)) {
        best = right;
      }
      if (best === index) break;
      swap(index, best);
      index = best;
    }
  };

  return {
    push(time, priority, run) {
      if (!Number.isFinite(time)) {
        throw new Error(`event scheduled at a non-finite sim time: ${time}`);
      }
      heap.push({ time, priority, sequence, run });
      sequence += 1;
      siftUp(heap.length - 1);
    },

    peekTime: () => heap[0]?.time,

    pop() {
      const top = heap[0];
      if (top === undefined) return undefined;
      const last = heap.pop() as ScheduledEvent;
      if (heap.length > 0) {
        heap[0] = last;
        siftDown(0);
      }
      return top;
    },

    size: () => heap.length,
  };
}
