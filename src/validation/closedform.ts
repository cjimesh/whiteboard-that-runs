/**
 * Textbook queueing results, in closed form.
 *
 * This file is the other half of the credibility claim (R13). The simulator's
 * answer is only worth anything if it agrees with results that were settled long
 * before it existed, so these are written from the standard formulas and never
 * from anything the simulator produced. Nothing here imports the engine, which is
 * the point: if the two agree, they agree independently.
 *
 * All rates are per second and all times are in seconds. `mu` is always the
 * service rate of *one* server.
 */

/** λ / (c·μ) — the fraction of total capacity in use. Unstable at 1 or above. */
export function utilization(lambda: number, mu: number, servers = 1): number {
  return lambda / (servers * mu);
}

/** M/M/1 mean time in system: W = 1 / (μ − λ). */
export function mm1MeanSojourn(lambda: number, mu: number): number {
  if (lambda >= mu) return Number.POSITIVE_INFINITY;
  return 1 / (mu - lambda);
}

/** M/M/1 mean number in system: L = ρ / (1 − ρ). */
export function mm1MeanResident(lambda: number, mu: number): number {
  const rho = utilization(lambda, mu);
  if (rho >= 1) return Number.POSITIVE_INFINITY;
  return rho / (1 - rho);
}

/**
 * Erlang B — the probability all `servers` are busy in a loss system, given
 * offered load `a = λ/μ` erlangs.
 *
 * Computed by the standard recursion rather than the factorial form, which
 * overflows for any server count worth modelling.
 */
export function erlangB(servers: number, offeredErlangs: number): number {
  let b = 1;
  for (let n = 1; n <= servers; n += 1) {
    b = (offeredErlangs * b) / (n + offeredErlangs * b);
  }
  return b;
}

/**
 * Erlang C — the probability an arrival has to wait in M/M/c.
 *
 * Derived from Erlang B, which is numerically well behaved: C = B / (1 − ρ(1 − B)).
 */
export function erlangC(servers: number, lambda: number, mu: number): number {
  const rho = utilization(lambda, mu, servers);
  if (rho >= 1) return 1;
  const b = erlangB(servers, lambda / mu);
  return b / (1 - rho * (1 - b));
}

/** M/M/c mean time spent waiting before service: Wq = C / (c·μ − λ). */
export function mmcMeanWait(lambda: number, mu: number, servers: number): number {
  if (utilization(lambda, mu, servers) >= 1) return Number.POSITIVE_INFINITY;
  return erlangC(servers, lambda, mu) / (servers * mu - lambda);
}

/** M/M/c mean time in system: Wq + 1/μ. Reduces exactly to M/M/1 at c = 1. */
export function mmcMeanSojourn(lambda: number, mu: number, servers: number): number {
  return mmcMeanWait(lambda, mu, servers) + 1 / mu;
}

/** M/M/c mean number in system, by Little's Law on the closed-form W. */
export function mmcMeanResident(lambda: number, mu: number, servers: number): number {
  return lambda * mmcMeanSojourn(lambda, mu, servers);
}

/**
 * M/D/1 mean time in system — constant service time rather than exponential.
 *
 * Not part of the validation set. It is here because the suite has to be able to
 * catch a component whose semantics have drifted, and the cheapest way to prove
 * it can is to point it at a node that is genuinely a different queue and check
 * that it objects. At ρ = 0.8 this sits about 40% below the M/M/1 result, which
 * is far outside any tolerance the suite declares.
 */
export function md1MeanSojourn(lambda: number, mu: number): number {
  const rho = utilization(lambda, mu);
  if (rho >= 1) return Number.POSITIVE_INFINITY;
  return 1 / mu + rho / (2 * mu * (1 - rho));
}

/**
 * How long the queue takes to forget where it started, in seconds.
 *
 * Relaxation time scales as 1/(c·μ·(1−ρ)²), which is why a fixed warm-up and a
 * fixed run length cannot serve every utilization point: at ρ = 0.9 the queue is
 * a hundred times slower to settle than at ρ = 0.5. Both the warm-up truncation
 * and the measurement window are sized from this, so the declared tolerance is
 * met by design rather than by finding out which points happened to pass.
 */
export function relaxationTime(lambda: number, mu: number, servers = 1): number {
  const rho = utilization(lambda, mu, servers);
  if (rho >= 1) return Number.POSITIVE_INFINITY;
  return 1 / (servers * mu * (1 - rho) ** 2);
}

/** Relative error of a measurement against its expected value. */
export function relativeError(measured: number, expected: number): number {
  if (expected === 0) return measured === 0 ? 0 : Number.POSITIVE_INFINITY;
  return Math.abs(measured / expected - 1);
}
