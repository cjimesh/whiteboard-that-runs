import { describe, expect, it } from "vitest";
import { compileFormula } from "./rate-formula.ts";

function value(text: string, t = 0, base = 10): number {
  const compiled = compileFormula(text);
  if (!compiled.ok) throw new Error(compiled.error);
  return compiled.evaluate(t, base);
}

function error(text: string): string {
  const compiled = compileFormula(text);
  if (compiled.ok) throw new Error(`"${text}" compiled`);
  return compiled.error;
}

describe("a rate formula", () => {
  it("reads t and base", () => {
    expect(value("t", 7)).toBe(7);
    expect(value("base", 0, 42)).toBe(42);
    expect(value("base * 2 + t", 3, 10)).toBe(23);
  });

  it("follows the precedence people write on paper", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("-2^2")).toBe(-4);
    expect(value("2^3^2")).toBe(512);
    expect(value("2 ** 3")).toBe(8);
    expect(value("10 % 4")).toBe(2);
  });

  it("knows its functions and constants", () => {
    expect(value("sin(pi / 2)")).toBeCloseTo(1);
    expect(value("max(1, 5, 3)")).toBe(5);
    expect(value("min(4, 2)")).toBe(2);
    expect(value("floor(2.7) + ceil(2.1) + round(2.5) + abs(-1)")).toBe(9);
    expect(value("pow(2, 10)")).toBe(1024);
    expect(value("exp(0) + log(e) + sqrt(9)")).toBe(5);
  });

  it("makes steps from comparisons and a ternary", () => {
    expect(value("t > 30 ? 80 : 20", 10)).toBe(20);
    expect(value("t > 30 ? 80 : 20", 31)).toBe(80);
    expect(value("t >= 10 && t < 20", 15)).toBe(1);
    expect(value("t < 10 || t > 20", 15)).toBe(0);
    expect(value("!(t == 5)", 5)).toBe(0);
    expect(value("t != 5", 4)).toBe(1);
  });

  it("accepts a formula copied from JavaScript", () => {
    expect(value("Math.max(base, 2 * Math.sin(t))", 0, 3)).toBe(3);
  });

  it("refuses what it does not know, saying what", () => {
    expect(error("alert(1)")).toContain('"alert" is not a function');
    expect(error("window")).toContain('"window" is not known');
    expect(error("2 +")).toContain("ends too early");
    expect(error("2 3")).toContain('Unexpected "3"');
    expect(error("(2")).toContain('Expected ")"');
    expect(error("2 ; 3")).toContain('";" at position 3');
    expect(error("pow(2)")).toContain("pow() takes 2 values");
    expect(error("")).toContain("Enter a formula");
    expect(error("1+".repeat(300) + "1")).toContain("under 400 characters");
  });
});
