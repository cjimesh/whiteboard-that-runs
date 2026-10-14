# Whiteboard That Runs

**A system-design diagram you can put load through.** Draw the system under discussion, give each box
two numbers, and watch which component fails first. Change a timeout, a retry policy, or the shape
of the traffic while it runs, and the whole room sees the consequence within seconds.

**[Try it in your browser](https://cjimesh.github.io/whiteboard-that-runs/)**. Nothing to install,
and the page sends nothing anywhere.

[![The demo system under spiky load: it collapses into a retry storm, recovers when retries are switched off, then runs a load pattern typed as a formula.](docs/demo.gif)](docs/demo.mp4)

*Thirty seconds of the built-in demo. Spiky traffic that averages 26 requests a second, half of what
the database can handle, sends the system into a retry storm it does not recover from on its own. Switching retries off
brings it back with the spikes still arriving. The last part runs a load pattern typed as a formula.
[Full-resolution video](docs/demo.mp4).*

## Why it exists

Design reviews argue about numbers: how many connections the pool needs, whether three retries is
too many, what happens when traffic doubles for a minute. The consequences of those numbers are
non-linear and hard to reason about at a whiteboard. In the built-in demo, a retry policy that is
harmless at 22 requests a second takes the system to zero throughput at 44, against a database that
handles 50. The component that turns red is often the victim of the one that failed.

This tool runs the diagram so the review can see those consequences instead of estimating them. It
computes what a system with the stated properties would do. It does not check that the properties
are correct, and it is not a capacity planner for a production system.

## Try it

Open **https://cjimesh.github.io/whiteboard-that-runs/**. It opens on a running example system with
a short tour beside it.

## Saving and opening

Nothing is stored on the site, and there is no account. A model lives in a file on your computer.

- **Save** downloads the model as a `.whiteboard.json` file, including its load pattern and any
  changes you kept from a run.
- **Open…** loads a saved file back. To share a model, send the file; the other person opens it at
  the same link.
- The browser warns before you close the page with unsaved changes. If you close it anyway, they are
  gone.
- The file is plain, indented JSON, so it can sit in a repository next to the design document it
  supports.

## Using it offline

The whole app is one file. In your browser, choose **Save page as…** and pick **Webpage, HTML only**.
The saved file runs from disk with no connection, and works the same as the hosted copy.

## What you can do

- **Draw a system** from load balancers, app servers, databases, in-memory stores, caches, queues
  with workers, and session pools. Each box asks two questions, **How many at once?** and **How
  long does one take?**, and shows the capacity they imply.
- **Run it and steer it live.** Drag the load, change a timeout, switch a retry policy, or turn off
  another team's traffic. Each change applies to the running simulation without a restart and
  appears as a chip under the canvas, and the whole session can be replayed exactly. Changes stay
  with the run until you press **Keep these changes**, which makes them part of the model.
- **Shape the traffic.** Choose steady, spiky, or random load, a schedule of steps, or a formula of
  your own. The pattern is saved with the model. See [Load patterns](#load-patterns).
- **Find the breaking point.** One button brackets the sustained rate the design holds to, names
  the component where the trouble starts, and says so when a design has no clean threshold.
- **Compare a proposal.** Mark the components this month's proposal adds and get the breaking point
  with and without them, on identical traffic.
- **Check it against the textbook.** **Why trust this?** runs the same queueing-theory checks as the
  test suite, on screen.
- **Present it.** **Present** shows the canvas at full width with large figures for a meeting room.
- **Keep it private.** The page makes no network requests, so a model of a real system stays on the
  machine it was drawn on.

## Drawing your own

- **Start a model.** Choose **Edit model**, then **New…**. Pick a common shape (app servers and a
  database, a cache in front of a database, app servers sharing an in-memory store, or a queue and
  workers) or a blank canvas. Undo restores what was there before.
- **Answer two questions per box.** **How long does one take?** is the component's own work,
  excluding time spent waiting on anything downstream. Everything else is under **Details**.
- **Connect boxes.** Select a box, choose **Sends requests to…**, and click the box it sends to, or
  drag from one to the other. Arrowheads show the direction, and **Flip direction** reverses an arrow.
- **Say what an arrow means.** Click it and choose whether the sender passes the request on and
  waits, passes it on and moves on, or asks something along the way. Timeouts and retries are set on
  the arrow.
- **Mark what you know.** Every number starts as **assumed**. Typing a value marks it as stated, and
  one more click marks it as measured.
- **Run and steer.** Press **Run ▸**, then click a box to open its controls. The component that fails
  first opens on its own.
- **Keep what the room agreed.** Changes made during a run are experiments and leave the model alone.
  When one becomes the design, press **Keep these changes** (on any run started from the editor;
  the opening tour does not offer it). The run's settings are copied into the model, every number
  that moved is marked as stated, and **Save** writes them to the file. Undo in the editor takes
  them back.

## Load patterns

A load pattern sets how the load moves over time. Choose one under **Requests per second** in the
editor, where it is saved with the model, or from the **Pattern** menu next to the load slider while
the model runs. A run starts on the model's saved pattern. The slider stays the number being
discussed, and the pattern describes the traffic around it.

| Pattern | What it does | Settings |
| --- | --- | --- |
| **Steady** | The slider's rate, all the time. | None |
| **Steps** | A schedule of rates typed in the editor, played once. Load stops when it ends. The slider starts at the first step's rate and scales every step in proportion. | Each step's rate and duration (in the editor) |
| **Spiky** | The slider's rate, with a burst at the end of every period. | Spike height (× the load), how long it lasts, how often it comes |
| **Random** | A new rate every few seconds, drawn evenly within a band around the slider. It averages to the slider's rate. | Swing (±%), how long each rate holds |
| **Formula** | Any rate you can write as a function of time. | The formula |

Under the settings, a line states the average and peak rate the pattern produces over the next hour,
or until a schedule of steps ends. In the editor, a spiky, random or formula pattern is set around a
**Base** rate, which is where the slider starts.
Patterns follow simulation time since the run started, so dragging the slider during a spiky run
changes the height of the spikes and leaves their timing alone. Random load comes from the run's seed,
so **Rerun clean** and a replay see the same traffic.

### Writing a formula

A formula gives requests per second at time `t`, in seconds since the run started. `base` is the
slider's value, or the base rate in the editor. The formula is read once a second, and a negative result counts as no traffic.

| Shape | Formula |
| --- | --- |
| A wave around the slider, once a minute | `base * (1 + 0.5 * sin(2 * pi * t / 60))` |
| A step to double the load after a minute | `t < 60 ? base : base * 2` |
| A two-second burst every thirty seconds | `t % 30 < 2 ? base * 4 : base` |
| A ramp from zero to the slider over two minutes | `base * min(1, t / 120)` |
| Square waves between two levels | `t % 40 < 20 ? base : base * 1.8` |

The language supports numbers, `t`, `base`, `pi` and `e`; the operators `+ - * / %` and `^` (or `**`)
for powers; comparisons, `&&`, `||`, `!` and `condition ? a : b`; and the functions `sin`, `cos`,
`tan`, `abs`, `min`, `max`, `floor`, `ceil`, `round`, `sqrt`, `exp`, `log` and `pow`. A `Math.` prefix
is accepted, so a formula copied from JavaScript still works.

Formulas are parsed by the app itself and are never executed as code. The page's security policy
forbids evaluating code, and a formula can only compute a number. A formula that produces a value
that is not a number, or a rate more than ten times the slider's maximum, is refused with the time at
which it happens, and the run keeps the load it had.

**Breaking point** is unaffected by the pattern. It always measures sustained steady rates, so its
answer means the same thing whichever pattern is on screen.

## Modelling reference

**Hand-offs and calls.** An arrow is either a hand-off or a call. Work travels along a hand-off and
continues from there. A call is a request the component makes and waits on, holding its own slot
until the answer arrives. Calls let a shared dependency such as a Redis instance or a primary
database be drawn once and called from many places, so its callers slow down together, as they do in
production. A component hands work on to exactly one place; any further arrows out of it are calls,
each with a count of calls per request. Calls are drawn as dashed ribbons.

**Timeouts and retries on a call.** Click a call and, under **If it is slow**, set a timeout and a
number of retries. An attempt the caller gives up on is abandoned but not cancelled: it stays queued
or in progress at the dependency while the retry joins the queue behind it. That duplicate work is
what drives a retry storm. Once a call retries, two more fields appear: how long to wait before the
first retry (later waits grow from it), and a **retry budget**, the share of requests that may be
retried at all. Past the budget a failed call fails the request instead of asking again, with up to
10 retries saved for a burst. The same fields are on a component's own arrow. Calls with a policy get
a live control on the run screen, budget included, and the demo's **Retry policy** menu has a
budgeted option.

**Leases.** Some components keep their slot after answering. A connection or session pool is the
usual case: a request claims a resource, gets a reply in seconds, and the resource stays allocated for
minutes. Set **Holds its slot** and a **Hold time**, and capacity is calculated from the hold time.

**Other traffic.** A shared component usually serves more than the path being modelled. Select a
component with nothing wired out of it, such as a datastore or a cache, choose **Add other traffic**,
and give it a name and a rate. That traffic occupies the component's servers, queue and lease, and is
kept out of the whole-path totals. Its rate is a live control, so "what if the batch job were not
running" takes one keystroke during a run.

**Amber and red.** Red means a box is losing work; amber means it is working hard. The same
conditions are in the legend on the run screen.

- **Red:** in the last 1.5 seconds, the box turned requests away (its queue was full, or it shed old
  work), or it finished work whose caller had already given up waiting.
- **Amber:** its servers were busy at least 85% of the time, or its queue is at least 20% full.
- **Green:** neither.

A full queue on its own is amber, not red, because a queue that has just absorbed a burst may be
draining. The second red condition is how a very deep queue fails: nothing is turned away, but every
caller times out before its answer arrives, so the work is done for nobody. Both red conditions count
things that happened, so one late answer is enough: the demo's database turns red for a moment now
and then even at its resting load, when a rare slow call outlasts the timeout. When several boxes
are red, one box is tagged **cause** and the red boxes waiting on it are marked **knock-on**, because a
caller that waits on a stuck dependency turns red with it. The cause is usually the red box with no red
box after it in the chain. It can also be an amber box that a red box is waiting on, if it is busy at
least 95% of the time: a caller with no timeout can only have so many calls open, so the component it
waits on never turns anything away, and the loss shows up at the caller instead. The amber
thresholds are judgement calls, not measurements. A box with no timeout anywhere in front of it can
fall further and further behind without losing anything, so it stays amber; **Breaking point** looks
for work that keeps piling up, so it catches that case.

**Proposals and disputed numbers.** Mark components as part of **this month's proposal** to get the
breaking point with and without them. Mark a number as **disputed** to get the answer across its
range. A difference smaller than the sweep's resolution is reported as no improvement.

## How the answers are checked

**The simulator agrees with queueing theory.** **Why trust this?** runs M/M/1 mean latency against
`1/(μ−λ)` for utilisation from 0.5 to 0.95, M/M/c against Erlang C up to eight servers, and Little's
Law at every node. The on-screen panel and the test suite share one code path and one budget: 10⁶
completions per point, with a warm-up sized from each point's relaxation time. Three self-check tests
confirm the suite can fail, by presenting it with an M/D/1 queue, a wrong server count, and a bounded
queue checked against the unbounded formula.

**Breaking point reports a range.** The sweep runs in a background worker at a series of steady rates
until it has bracketed the rate at which the system stops holding, for example "Holds to ~26/s. Folds
by 27.5/s." A rate **folds** when more than 2% of its requests are lost, or when work piles up by more
than 1% of the rate every second, over 240 seconds; the table shows the share lost at every rate tried,
so a stricter bar can be read straight off it. It stops at an 8% gap, the detector's measured resolution. It then re-runs the holding
rate on a different arrival stream; if that run fails, the readout says the design has no clean
threshold instead of quoting a number. It refuses a model it cannot sweep in a few seconds and shows
the calculation behind the refusal.

**The demo's claims are tests.** `src/ui/demo.test.ts` checks that the resting load holds across
three seeds, that 44 requests a second collapses, and that the recovery the tour describes is the
recovery the model produces. `scripts/capture-video.ts` checks the same arc while recording the
video above, and fails if the collapse or the recovery does not happen.

## No network access

The application is one HTML file whose content-security policy blocks every network destination.
You can verify this:

- `test/build-output.test.ts` builds the real file, opens it in Chromium over `file://` with every
  non-`file:` request blocked and recorded, exercises the demo, the editor, the validation suite and
  a breaking-point study, and checks that no request was attempted.
- A test checks that the security policy is the first element in the shipped file's `<head>` and
  contains no host sources or wildcards.
- `npm audit` reports no issues, and the build produces one file with nothing to fetch.

## What it can't model yet

- **Request classes.** Every request is treated the same, so there is no distinction between reads
  and writes, no per-tenant admission control, and no per-class SLA.
- **Retries on other traffic.** Other traffic has no call policy, so a retry storm driven mainly by
  load you did not draw cannot be modelled yet.
- **Fan-out as a distribution.** The number of calls per request is a single number. Where the tail
  is the problem, the mean produces a model that looks healthy and misses the failure.
- **More than one meaning of "done".** An asynchronous write has two endpoints, the reply the user
  waited for and the background work, and the readout reports the second.
- **Batching and parallel calls.** Dependencies are called one at a time, and nothing is batched.
- **Proposals that only add an arrow.** A proposal has to add a component.

Out of scope by design: circuit breakers and bulkheads, rate limiting, scatter-gather with a join,
cache TTL and key space, autoscaling, and network latency on a wire. Arrows take no time, so anything
that costs time has to be drawn as a component.

## Building from source

`npm install`, then `npm run build` produces `dist/index.html`. `npm test` runs the full suite,
including the browser checks behind the no-network claim.

## License

MIT. See [LICENSE](LICENSE).
