import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration, parseDuration } from "../src/wire.ts";

describe("parseDuration", () => {
  const cases: Array<[string, number]> = [
    ["10s", 10_000],
    ["1m30s", 90_000],
    ["1.5s", 1500],
    ["250ms", 250],
    ["1h", 3_600_000],
    ["0s", 0],
    ["0", 0],
    ["-2s", -2000],
    ["500µs", 0.5],
  ];

  for (const [text, want] of cases) {
    it(text, () => {
      assert.ok(Math.abs(parseDuration(text) - want) < 1e-9);
    });
  }

  for (const text of ["", "10", "10x", "s", "1s2"]) {
    it(`rejects "${text}"`, () => {
      assert.throws(() => parseDuration(text), RangeError);
    });
  }
});

describe("formatDuration", () => {
  it("uses seconds for whole seconds", () => {
    assert.equal(formatDuration(10_000), "10s");
  });

  it("uses milliseconds otherwise", () => {
    assert.equal(formatDuration(1500), "1500ms");
  });
});
