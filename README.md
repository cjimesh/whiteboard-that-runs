# Whiteboard That Runs

A system-design canvas where the diagram runs. You draw a system from a handful of components, give
each one its numbers, put load through it, and watch where it fails. It is meant to be used live in a
design review, while the design is still being argued about.

The tool computes the consequences of the numbers you give it. It does not check that those numbers
are right, and it is not a capacity planner, so it cannot tell you what your production system will
do. It can tell you what a system with these properties would do, which is usually the question a
design review is trying to settle.

Everything runs in the browser. The application is a single HTML file whose content-security policy
blocks every network destination, so a model stays on the machine it was drawn on.

## Try it

```
npm install
npm run build      # produces dist/index.html, one self-contained file
```

Open `dist/index.html` directly from disk; running over `file://` is fully supported. You can also
use `npm run dev` for a development server, or `npm run package` to produce
`share/whiteboard-that-runs-<date>.zip` to send to someone.

The app opens on a running example system with a five-step tour beside it.

## Drawing your own

Choose **Edit model**, then **New…** to start from a common shape (app servers and a database, a
cache in front of a database, app servers sharing an in-memory store, or a queue and workers) or from
a blank canvas. Undo restores whatever was there before.

The palette lists components by what they are: load balancer, app server, database, in-memory store,
cache, queue and workers, and session pool. Each one comes with sensible behaviour for its kind, such
as how many connections it has or whether it keeps a slot after answering, so you answer questions
about your system instead of choosing simulation mechanisms. Each box asks two questions, **How many
at once?** and **How long does one take?**, and shows the capacity they imply ("Can serve about 1,000
a second"). Everything else is under **Details**.

To connect two boxes, select one, choose **Sends requests to…**, and click the other, or drag from
one box to the other. Every arrow has an arrowhead showing which way requests flow, and **Flip
direction** reverses an arrow drawn the wrong way round. Clicking an arrow asks **What does app-1 do
with db-1?**: it can pass the request on and wait, pass it on and move on, or ask something along the
way. If it waits, the arrow also asks how long to wait before giving up and how many times to retry.
Timeouts and retries are set on arrows because they belong to a call between two components.

Every number starts as **assumed**, and the box and a list of guesses both say so. Typing a value
marks it as stated, and one more click marks it as measured. Because the tool only claims to compute
the consequences of its inputs, keeping track of which inputs are guesses is part of the model.

While a model runs, click a box to steer it. Its controls open and the others close, and the
component that fails first opens on its own. Each live change appears as a chip under the canvas.
**Present** prepares the screen for a meeting room, with the canvas at full width, large figures, and
the selected box's controls beside it.

If you close or reload the page with changes you have not saved, the browser asks first. **Save**
downloads the model as a `.whiteboard.json` file, and **Open…** loads one back.

## The demo

The demo is a load balancer, two application replicas, and one database. Each of its numbers is one
a reviewer would accept: 2 ms of application work, a 250 ms timeout, three retries with backoff, and
a database that handles about fifty requests a second.

If you drag the load to 44 requests a second, which is below the database's capacity, goodput falls
to zero. Nothing is under-provisioned; the retries cause the collapse. Turning retries off restores
most of the throughput within seconds, live, without restarting anything.

These claims are covered by tests. `src/ui/demo.test.ts` checks that the resting load holds steady
across three seeds, that 44 requests a second does collapse, and that the recovery described in the
tour is the recovery the model produces, including the fact that it is only partial.

The demo is also available as a file. `fixtures/demo-system.json` opens in the editor, and a test
checks that it is byte-for-byte the model the app runs.

## Does the simulator agree with the textbook?

Press **Why trust this?** to run the same closed-form checks as the test suite, at the same budget:
M/M/1 mean latency against `1/(μ−λ)` for ρ from 0.5 to 0.95, M/M/c against Erlang C up to c = 8, and
Little's Law at every node. The on-screen panel and CI share one code path, so the figures shown in a
meeting come from the same run the tests use.

The budget is fixed in advance: 10⁶ completions per point, with a warm-up sized from each point's own
relaxation time. At 10⁵ completions, whether a ±5% check passed depended on the seed. The one wider
tolerance (±12% at ρ = 0.95) has a written justification, and a structural test requires the same of
any future change.

Three self-check tests confirm that the suite can fail: an M/D/1 queue presented as M/M/1, a wrong
server count, and a bounded queue checked against the unbounded formula.

## Leases

A component can keep its slot after it has answered. A resource pool behaves this way: a request
claims a resource, gets a reply within seconds, and the resource stays allocated for minutes until a
different request releases it.

This matters because every other component frees its capacity as soon as work leaves it. A pool
modelled that way looks idle even when it is the only real constraint. Set **Holds its slot** and a
**Hold time**, and capacity is then calculated from the hold time instead of the work time, for
example `11/s ⇒ held for 90 s × 1000 connections`.

A lease is modelled as an M/M/c server whose service time is the hold, with the caller released
early. It is therefore checked against Erlang C like everything else, and the validation panel runs
those checks on screen.

## Shared dependencies

An arrow is either a **hand-off** or a **call**. Work travels along a hand-off and continues from
there. A call is a request the component makes and waits on, holding its own slot until the answer
arrives.

This distinction allows a Redis instance, a shared primary database, or a token service to be drawn
once and called from many places. The alternative, folding its latency into each caller's own work
time, hides the fact that the callers share a server and slow down together, which is usually how
such systems fail. Drawing it behind a single caller understates its load by however many callers
were left out.

A component can have as many dependencies as it needs, but it hands work on to exactly one place.
A second arrow out of a component is therefore a call, with a count of calls per request, because a
request that reaches Redis twenty times puts twenty times the traffic on it. Dependencies are drawn
as dashed ribbons, since work does not travel through them and continue on the other side.

Fan-out with a join, meaning several successors with a wait for all of them, is not supported yet.

## Other traffic

Shared components usually serve more than the path being modelled. Select a component with nothing
wired out of it, such as a datastore or a cache, and choose **Add other traffic** to give it a name
and a rate for the load it already carries. Other traffic is not a component and is not wired to
anything; on the canvas it arrives on a short stub below the box.

These requests occupy the component's servers, its queue, and its lease, and then stop. They do not
travel further or call the component's dependencies, because the model only knows what the
component does for the modelled path. For the same reason, a component that hands work on cannot
carry other traffic. Other traffic is also kept out of the whole-path totals, since your requests and
another team's cache reads are not samples of the same latency. It is counted against its own rate,
so traffic being turned away at the door shows up instead of looking like an absence of contention.

Other traffic is a live control, so a question such as "what if the batch job weren't running" takes
one keystroke during a run. Changing it does not alter any arrival on the modelled path; only the
contention changes.

## Retries on a dependency call

A dependency call has its own timeout and retry count, set on the arrow next to the number of calls
per request. Click the arrow and, under **If it is slow**, enter a timeout in milliseconds and a
number of retries; a sentence below them describes what the call will now do. These settings belong
to the call because that is where they live in a real system. "Every Redis read is retried once on
timeout" is a setting of the Redis client, and the component using it may treat its other
dependencies differently.

When a caller gives up on an attempt, the attempt is abandoned but not cancelled. It stays at the
dependency, queued or in progress, while the retry joins the queue behind it. On a single-threaded
dependency at 80% load, one retry on a 10 ms timeout doubles the work it is asked to do and takes the
path from serving every request to serving none. Without the retry, the same timeout gives up on
as many calls as M/M/1 predicts. Calls with a policy get a live control on the run screen, so
a change such as "stop retrying Redis" takes one keystroke mid-run, and it can be replayed.

## Breaking point

Press **Breaking point**. The model runs in a background worker at a series of steady rates until
it has bracketed the rate at which the system stops holding, while the live view keeps running.

Several properties of the answer are intentional:

- **The answer is a range.** For example, "Holds to ~26/s. Folds by 27.5/s." The search stops at an
  8% gap, which is the detector's measured resolution: on an M/M/1 queue at this budget, five seeds
  agree up to λ = 47.5 and from λ = 51 onward, and disagree in between, including at exactly ρ = 1.
- **It reports when a design has no clean threshold.** After bracketing, it runs the holding rate
  once more on a different arrival stream. If that run fails, the bracket depended on the seed, and
  the readout says so instead of quoting a number. The demo system triggers this on 3 seeds in 12.
- **It names the component where the trouble started.** In a graph where callers wait on their
  dependencies, a saturated datastore turns everything in front of it red, and the readout names the
  datastore.
- **It refuses a model it cannot sweep in a few seconds** and shows the calculation behind the
  refusal, instead of freezing the page.

Mark components as part of **this month's proposal** and it reports the breaking point both with and
without them, from one model and on identical traffic. Mark a number as **disputed** and it reports
the answer across that number's range. A difference smaller than the sweep's own resolution is
reported as no improvement.

## No network access, and how to check it

The page makes no network requests at all, and you can verify this yourself:

- `test/build-output.test.ts` builds the real file, opens it in Chromium over `file://` with every
  non-`file:` request blocked and recorded, then exercises the demo, the editor, the validation
  suite, and a breaking-point study, and checks that no request was attempted.
- A test checks that the content-security policy is the first element in the `<head>` of the shipped
  file and that it contains no host sources or wildcards.
- `npm audit` reports no issues, and the build produces exactly one file with nothing to fetch.

```
npm test           # 550+ tests, including the build and browser checks
npm audit
```

## What it can't model yet

- **Request classes.** Every request is treated the same, so there is no distinction between reads
  and writes, no per-tenant admission control, and no per-class SLA. "What breaks first" is answered
  in terms of shared capacity, even where most refusals are due to policy.
- **Retries on other traffic.** Other traffic is a rate on a component with no call policy, so a
  retry storm driven mainly by load you did not draw cannot be modelled yet.
- **Fan-out as a distribution.** `times` is a single number. Where the tail is the problem, using the
  mean produces a model that runs and looks healthy but misses the failure that matters.
- **More than one meaning of "done".** An asynchronous write has two endpoints, the reply the user
  waited for and the background work, and the readout reports the second.
- **Batching and parallel calls.** Dependencies are called one at a time, and nothing is batched.
- **Proposals that only add an arrow.** A proposal has to add a component.

Out of scope from the start: circuit breakers and bulkheads, rate limiting, retry budgets and token
buckets, scatter-gather with a join, cache TTL and key space, autoscaling, and network latency on a
wire. Arrows take no time, so anything that costs time has to be drawn as a component.

## Working on it

```
npm test                           # all tests
npm run test:watch
npm run build                      # type-check and single-file build
npm run capture                    # docs/demo-*.png; also checks the demo still collapses and recovers
node scripts/capture-verdict.ts    # docs/verdict-*.png
node scripts/capture-comparison.ts # docs/compare-*.png
node scripts/capture-traffic.ts    # docs/traffic-*.png
node scripts/capture-calls.ts      # docs/calls-*.png
node scripts/capture-ux.ts         # docs/ux-*.png: the editor's questions, a run, Present mode
npm run package                    # share/<name>-<date>.zip
```

The screenshots in `docs/` are visual checks that a test cannot make. Every capture runs against the
built `dist/index.html` over `file://`, so the screenshots show the same file a recipient would open.

## Status

All eight planned units are built and passing, along with leases, shared dependencies, other traffic
on a shared component, timeouts and retries on dependency calls, and a question-first editor with a
Present mode. The remaining gaps are listed under **What it can't model yet**.
