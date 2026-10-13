/**
 * A traffic shape typed as a formula: `base * (1 + 0.5 * sin(2 * pi * t / 60))`.
 *
 * The obvious implementation is `new Function`, and the page cannot use it. The
 * pinned content-security policy has no `'unsafe-eval'` (see `csp.ts`), and it
 * should not get one for this: a model file that carried code would be a model
 * file that could do anything. So this is a small arithmetic language with its
 * own parser. It can compute a number from `t` and `base` and do nothing else,
 * which is everything a load shape needs.
 *
 * The language, in full:
 *
 * - numbers, `t` (sim seconds since the run started), `base` (the load slider),
 *   and the constants `pi` and `e`;
 * - `+ - * / %`, and `^` or `**` for powers;
 * - comparisons `< <= > >= == !=`, `&&`, `||`, `!`, and `a ? b : c`, where true
 *   is 1 and false is 0, so `t > 30 ? 80 : 20` is a step;
 * - `sin cos tan abs min max floor ceil round sqrt exp log pow`.
 *
 * A `Math.` prefix is accepted and ignored, so a formula copied from JavaScript
 * still reads.
 */

export type RateFunction = (t: number, base: number) => number;

export type CompiledFormula = { ok: true; evaluate: RateFunction } | { ok: false; error: string };

/** Long enough for any shape somebody would type, short enough to read back. */
const MAX_LENGTH = 400;

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...args: number[]) => number }> = {
  sin: { arity: [1, 1], fn: Math.sin },
  cos: { arity: [1, 1], fn: Math.cos },
  tan: { arity: [1, 1], fn: Math.tan },
  abs: { arity: [1, 1], fn: Math.abs },
  floor: { arity: [1, 1], fn: Math.floor },
  ceil: { arity: [1, 1], fn: Math.ceil },
  round: { arity: [1, 1], fn: Math.round },
  sqrt: { arity: [1, 1], fn: Math.sqrt },
  exp: { arity: [1, 1], fn: Math.exp },
  log: { arity: [1, 1], fn: Math.log },
  pow: { arity: [2, 2], fn: Math.pow },
  min: { arity: [1, Infinity], fn: Math.min },
  max: { arity: [1, Infinity], fn: Math.max },
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  | { kind: "number"; value: number; at: number }
  | { kind: "name"; value: string; at: number }
  | { kind: "op"; value: string; at: number }
  | { kind: "end"; at: number };

// Longest first, so `<=` is never read as `<` followed by `=`.
const OPERATORS = ["**", "<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", ","];

class FormulaError extends Error {}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    const number = /^(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/.exec(text.slice(i));
    if (number !== null) {
      tokens.push({ kind: "number", value: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }

    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (name !== null) {
      tokens.push({ kind: "name", value: name[0], at: i });
      i += name[0].length;
      // `Math.sin` reads as `sin`: drop the prefix and its dot together.
      if (name[0] === "Math" && text[i] === ".") {
        tokens.pop();
        i += 1;
      }
      continue;
    }

    const op = OPERATORS.find((candidate) => text.startsWith(candidate, i));
    if (op === undefined) throw new FormulaError(`"${ch}" at position ${i + 1} is not part of a formula.`);
    tokens.push({ kind: "op", value: op, at: i });
    i += op.length;
  }
  tokens.push({ kind: "end", at: text.length });
  return tokens;
}

/** A node of the parsed formula, already closed over its children. */
type Node = (t: number, base: number) => number;

const truth = (value: number): boolean => value !== 0;

function parse(tokens: Token[]): Node {
  let index = 0;
  const peek = (): Token => tokens[index] as Token;
  const isOp = (value: string): boolean => {
    const token = peek();
    return token.kind === "op" && token.value === value;
  };
  const expect = (value: string): void => {
    if (!isOp(value)) throw new FormulaError(`Expected "${value}" at position ${peek().at + 1}.`);
    index += 1;
  };

  const ternary = (): Node => {
    const test = or();
    if (!isOp("?")) return test;
    index += 1;
    const yes = ternary();
    expect(":");
    const no = ternary();
    return (t, b) => (truth(test(t, b)) ? yes(t, b) : no(t, b));
  };

  const or = (): Node => {
    let left = and();
    while (isOp("||")) {
      index += 1;
      const l = left;
      const r = and();
      left = (t, b) => (truth(l(t, b)) || truth(r(t, b)) ? 1 : 0);
    }
    return left;
  };

  const and = (): Node => {
    let left = comparison();
    while (isOp("&&")) {
      index += 1;
      const l = left;
      const r = comparison();
      left = (t, b) => (truth(l(t, b)) && truth(r(t, b)) ? 1 : 0);
    }
    return left;
  };

  const COMPARE: Record<string, (a: number, b: number) => boolean> = {
    "<": (a, b) => a < b,
    "<=": (a, b) => a <= b,
    ">": (a, b) => a > b,
    ">=": (a, b) => a >= b,
    "==": (a, b) => a === b,
    "!=": (a, b) => a !== b,
  };

  const comparison = (): Node => {
    const left = additive();
    const token = peek();
    if (token.kind !== "op" || !(token.value in COMPARE)) return left;
    index += 1;
    const compare = COMPARE[token.value] as (a: number, b: number) => boolean;
    const right = additive();
    return (t, b) => (compare(left(t, b), right(t, b)) ? 1 : 0);
  };

  const additive = (): Node => {
    let left = multiplicative();
    while (isOp("+") || isOp("-")) {
      const op = (peek() as { value: string }).value;
      index += 1;
      const l = left;
      const r = multiplicative();
      left = op === "+" ? (t, b) => l(t, b) + r(t, b) : (t, b) => l(t, b) - r(t, b);
    }
    return left;
  };

  const multiplicative = (): Node => {
    let left = unary();
    while (isOp("*") || isOp("/") || isOp("%")) {
      const op = (peek() as { value: string }).value;
      index += 1;
      const l = left;
      const r = unary();
      left =
        op === "*"
          ? (t, b) => l(t, b) * r(t, b)
          : op === "/"
            ? (t, b) => l(t, b) / r(t, b)
            : (t, b) => l(t, b) % r(t, b);
    }
    return left;
  };

  // Unary binds looser than a power, so `-2^2` is -4, as it is on paper.
  const unary = (): Node => {
    if (isOp("-")) {
      index += 1;
      const operand = unary();
      return (t, b) => -operand(t, b);
    }
    if (isOp("+")) {
      index += 1;
      return unary();
    }
    if (isOp("!")) {
      index += 1;
      const operand = unary();
      return (t, b) => (truth(operand(t, b)) ? 0 : 1);
    }
    return power();
  };

  const power = (): Node => {
    const left = primary();
    if (!isOp("^") && !isOp("**")) return left;
    index += 1;
    const right = unary();
    return (t, b) => Math.pow(left(t, b), right(t, b));
  };

  const primary = (): Node => {
    const token = peek();
    if (token.kind === "number") {
      index += 1;
      const value = token.value;
      return () => value;
    }
    if (token.kind === "op" && token.value === "(") {
      index += 1;
      const inner = ternary();
      expect(")");
      return inner;
    }
    if (token.kind === "name") {
      index += 1;
      const name = token.value;
      if (isOp("(")) {
        const entry = FUNCTIONS[name];
        if (entry === undefined) throw new FormulaError(`"${name}" is not a function this formula knows.`);
        index += 1;
        const args: Node[] = [];
        if (!isOp(")")) {
          args.push(ternary());
          while (isOp(",")) {
            index += 1;
            args.push(ternary());
          }
        }
        expect(")");
        const [least, most] = entry.arity;
        if (args.length < least || args.length > most) {
          const wanted = least === most ? `${least}` : `at least ${least}`;
          throw new FormulaError(`${name}() takes ${wanted} value${least === 1 && most === 1 ? "" : "s"}, got ${args.length}.`);
        }
        const fn = entry.fn;
        return (t, b) => fn(...args.map((arg) => arg(t, b)));
      }
      if (name === "t") return (t) => t;
      if (name === "base") return (_t, b) => b;
      const constant = CONSTANTS[name];
      if (constant !== undefined) return () => constant;
      throw new FormulaError(`"${name}" is not known. Use t for time in seconds and base for the load slider.`);
    }
    if (token.kind === "end") throw new FormulaError("The formula ends too early.");
    throw new FormulaError(`Unexpected "${token.value}" at position ${token.at + 1}.`);
  };

  const root = ternary();
  const rest = peek();
  if (rest.kind !== "end") {
    throw new FormulaError(`Unexpected "${rest.value}" at position ${rest.at + 1}.`);
  }
  return root;
}

/** Parse a formula once. Never throws: the caller is a text field. */
export function compileFormula(text: string): CompiledFormula {
  const trimmed = text.trim();
  if (trimmed === "") return { ok: false, error: "Enter a formula in t, for example base * (1 + 0.5 * sin(t / 10))." };
  if (trimmed.length > MAX_LENGTH) return { ok: false, error: `Keep the formula under ${MAX_LENGTH} characters.` };
  try {
    return { ok: true, evaluate: parse(tokenize(trimmed)) };
  } catch (error) {
    if (error instanceof FormulaError) return { ok: false, error: error.message };
    throw error;
  }
}
