# Whiteboard That Runs

A system-design canvas where the diagram **runs**. Draw a system from five components, give each one
its real numbers, put load through it, and watch where it folds — live, in the room, while people are
arguing about it.

It computes the **correct consequences of the numbers you give it**. It does not claim your numbers
are right, and it is not a capacity planner: it will not tell you what your production system does.
It tells you what a system with these properties would do, which is the thing a design review is
arguing about anyway.

Everything runs in the browser. The whole application is one HTML file with a content-security policy
that forbids every network destination, so a model never leaves the machine it was drawn on.

## Try it

```
npm install
npm run build      # → dist/index.html, one self-contained file
```

Open `dist/index.html` directly — `file://` is a supported way to run this, not a fallback. Or
`npm run dev` for a dev server, or `npm run package` to produce `share/whiteboard-that-runs-<date>.zip`
to send to somebody.

It opens on a running system rather than an empty canvas, with a five-step tour beside it.

## Drawing your own

**Edit model**, then **New…** to start from a common shape — app servers and a database, a cache in
front of a database, app servers sharing an in-memory store, a queue and workers — or a blank canvas.
Undo brings back whatever was there.

The palette offers things by what they are: load balancer, app server, database, in-memory store,
cache, queue + workers, session pool. Each sets the behaviour that kind of thing has — one connection
or ten, a slot freed with the answer or held for a minute — so the author answers questions instead
of choosing mechanisms. A box asks two: **How many at once?** and **How long does one take?**, and says
what they add up to ("Can serve about 1,000 a second"). Everything else is under **Details**.

**Drag from one box to another** to connect them. Click the arrow and it asks **What does app-1 do
with db-1?** — passes the request on and waits, passes it on and moves on, or asks it something along
the way — and, if it waits, how long before it gives up and how many times it asks again. Timeouts and
retries live on arrows, because they govern a call, not a box.

Every number starts **assumed** and says so, on the box and in a list of guesses; typing one makes it
stated, and one more click marks it measured. The tool claims correct consequences of debatable
inputs, so which inputs are guesses is part of the model.

When it runs, **click a box to steer it**: its knobs open and the others close. Whatever folds first
opens its own. Each live change appears as a chip under the canvas. **Present** clears the screen for a
room: the canvas full width, big numbers, and the selected box's knobs beside it.

## The demo arc

A balancer, two application replicas, one database. Every number in it is one a reviewer would nod
at: 2 ms of application work, a 250 ms timeout, three retries with backoff, a database that manages
about fifty requests a second.

Drag the load to 44/s — under the database's capacity — and it collapses to zero goodput. Nothing is
over-provisioned; the collapse is produced by the retries. Turning retries off brings it most of the
way back within seconds, live, with nothing restarted.

The arc's claims are tested, not narrated: see `src/ui/demo.test.ts`, which asserts that the resting
load holds unattended across three seeds, that 44/s does collapse, and that the recovery the tour
promises is the recovery the model delivers — including that it is *partial*.

The model is also a file: `fixtures/demo-system.json` opens in the editor, and a test asserts it is
byte-for-byte the demo the app runs.

## Does the simulator agree with the textbook?

Press **Why trust this?**. It runs the same closed-form checks the test suite runs, at the same declared
budget, live: M/M/1 mean latency against `1/(μ−λ)` across ρ = 0.5 to 0.95, M/M/c against Erlang C
including c = 8, and Little's Law per node. One code path serves both CI and the on-screen panel —
the argument dies if the numbers shown to a room came from a friendlier run than the tests use.

The budget is declared rather than tuned: 10⁶ completions per point, warm-up sized from each point's
own relaxation time. At the 10⁵ first tried, a ±5% claim was decided by which seed happened to run.
The one widened tolerance (±12% at ρ = 0.95) carries a written reason and a structural test enforces
that any future widening does too.

Three self-check tests prove the suite can go red: an M/D/1 queue disguised as M/M/1, a wrong server
count, and a bounded queue checked against the unbounded formula.

## Leases

A component can keep its slot after it has answered. That is what a resource pool does: a request
claims something, gets a reply in seconds, and the thing stays lent out for minutes — released by a
different request entirely.

It matters because every other component here frees its concurrency the moment work leaves it, and a
pool drawn that way reads as idle while it is the only thing that binds. Set **Holds its slot** and a
**Hold time**, and capacity follows the lease rather than the work: `11/s ⇒ held for 90 s × 1000
connections`.

A lease is an M/M/c server whose service time is the hold, with the caller let go early — so it is
checked against Erlang C like everything else, and the validation panel runs those points in front of
you.

## Shared dependencies

An edge is either a **hand-off** or a **call**. Work travels along a hand-off and carries on; a call
is something a component asks and waits for, holding its own slot until the answer.

That distinction is what lets a Redis, a shared primary database or a token service be drawn once and
called from everywhere, instead of being folded into each caller's own service time. Folding it in
hides that the callers share a server and degrade together, which is usually the failure mode; drawing
it behind one caller understates its load by however many callers were left out.

A component may have as many dependencies as it really has and still hands work on to exactly one
place — a second arrow out of a component is something it asks along the way, with a
calls-per-request count, because a request that touches
Redis twenty times puts twenty times the traffic on it. Dependencies are drawn as broken ribbons: work
does not travel along them and come out the other end.

Fan-out with a join — several successors, waiting for all of them — is still refused.

## Other traffic

A shared component is shared with somebody. Select a component nothing is wired out of — a datastore
or a cache — and **Add other traffic**: a name and a rate, for the load it already carries before this
design asks anything of it. It is not a component and it is wired to nothing; on the canvas it arrives
on a stub below the box, along no wire, which is exactly the claim.

Those requests occupy the component's servers, its queue and its lease, and then stop. They do not
travel on and they do not call its dependencies, because this model knows what the component does for
*this* path and nothing about what the other traffic asks of it — so a component that hands work on is
refused rather than guessed at. They are kept off the whole-path totals for the same reason: a request
of yours and somebody else's cache read are not two samples of one latency. What they are counted
against is their own rate, so traffic being turned away at the door is visible rather than looking
like no contention at all.

It is a live knob, so **what if the batch job weren't running** is one keystroke mid-run, and stating
it does not move a single arrival of the modelled path — turning the neighbours up and down changes
contention and nothing else.

## Retries on a dependency call

A dependency call has its own timeout and retry, set on the call beside how many times it is made:
click the arrow, and under **If it is slow** it takes a timeout in milliseconds and a number of
retries, with a sentence under them saying what the call now does. They belong to the call
and not to either component, because that is where they live in a real system — "every Redis read is
retried once on timeout" is a setting of the Redis client, and the component holding it may treat its
other dependencies differently.

An attempt the caller gives up on is abandoned, not cancelled: it stays at the dependency, queued or
being served, while the retry joins the queue behind it. On a single-threaded spine at 80% load, one
retry on a 10 ms timeout doubles what the spine is asked and takes the path from serving everything
to serving nothing — and without the retry, the same timeout gives up on exactly as many calls as
M/M/1 says it should. Calls that have a policy get a live control on the run surface, so **stop
retrying Redis** is a keystroke mid-run, and it replays.

## Breaking point

Press **Breaking point**. The model runs headless at one steady rate after another until the rate it
stops holding is bracketed, in a worker, while the live view keeps running.

Four things about the answer are deliberate:

- **It is a bracket, never a point.** "Holds to ~26/s, folds by 27.5/s". The search stops at 8%,
  which is the detector's measured discrimination limit — on an M/M/1 queue at this budget, five
  seeds agree up to λ = 47.5 and from λ = 51, and disagree in between, including at ρ = 1.000 exactly.
- **It says when a design has no clean threshold.** After bracketing, one more probe re-runs the
  holding rate on a different arrival stream. If that folds, the bracket was a fact about the seed,
  and the readout says so instead of quoting a number. The demo system triggers this on 3 seeds in 12.
- **It names the component that started the trouble**, not the ones merely downstream of it. In a
  call-and-wait graph a saturated datastore reddens everything in front of it.
- **It refuses a model it cannot sweep in a few seconds**, with the arithmetic, rather than freezing.

Mark components as **this month's proposal** and it reports the breaking point with and without them,
from one model, on identical traffic. Mark a number as **disputed** and it reports the answer across
the range. A difference smaller than the sweep's own resolution is reported as buying nothing.

## Zero egress, and how to check it

The claim is that this page has no network destinations at all. You do not have to take that on
trust:

- `test/build-output.test.ts` builds the real artifact, opens it in Chromium over `file://` with
  **every non-`file:` request aborted and recorded**, drives the demo, the editor, the validation
  suite and a breaking-point study, and asserts nothing was attempted.
- The pinned policy is asserted to be the first element in `<head>` of the shipped file, and the
  policy string is checked to contain no host source and no wildcard.
- `npm audit` runs clean; the build produces exactly one file with nothing to fetch.

```
npm test           # 490+ tests, including the build and browser checks
npm audit
```

## What it can't model yet

- **Request classes.** Every request is the same request, so there is no read versus write, no
  per-tenant admission control and no per-class SLA. "What breaks first" is answered about shared
  capacity even where most refusals are policy rather than capacity.
- **Retries on other traffic.** Other traffic is a rate on a component, with no call policy, so a
  retry storm that rides mostly on load you did not draw cannot be asked about yet.
- **Fan-out as a distribution.** `times` is one number. Where the tail is the problem, stating the
  mean gives a model that runs, looks healthy, and is wrong about the failure that matters.
- **More than one notion of "done".** An asynchronous write has the answer the user waited for and
  the background work; the readout reports the second.
- **Batching and parallel calls.** Dependencies are asked one at a time and nothing batches.
- **An edge-only proposal.** A proposal has to add a component; it cannot be a new arrow alone.

Known and deliberate from the start: circuit breakers and bulkheads · rate limiting · retry budgets
and token buckets · scatter-gather with a join · cache TTL and key space · autoscaling · network
latency on a wire. A wire costs nothing, so anything that costs time has to be a component.

## Working on it

```
npm test                          # everything
npm run test:watch
npm run build                     # typecheck + single-file build
npm run capture                   # docs/demo-*.png, and asserts the arc still collapses and recovers
node scripts/capture-verdict.ts   # docs/verdict-*.png
node scripts/capture-comparison.ts # docs/compare-*.png
node scripts/capture-traffic.ts    # docs/traffic-*.png
node scripts/capture-calls.ts      # docs/calls-*.png
node scripts/capture-ux.ts         # docs/ux-*.png — the editor's questions, the run, Present mode
npm run package                   # share/<name>-<date>.zip
```

Frames in `docs/` are the eyeball checks a test cannot make. Every capture runs against the shipped
`dist/index.html` over `file://`, so what is photographed is the artifact somebody is sent.

## State

U1–U8 built and green, plus leases, shared dependencies, other traffic on a shared component, a
timeout and retry on a dependency call, and a question-first editor with a Present mode for the room.
What remains is listed under **What it can't model yet**.
