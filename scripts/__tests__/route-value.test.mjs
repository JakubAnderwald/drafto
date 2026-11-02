import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { normaliseRouteValue, isAbsentValue } from "../lib/route-value.mjs";

describe("normaliseRouteValue (pure)", () => {
  it("returns trimmed strings and stringifies numbers", () => {
    assert.equal(normaliseRouteValue("  123  "), "123");
    assert.equal(normaliseRouteValue(42), "42");
    assert.equal(normaliseRouteValue("nullable@example.com"), "nullable@example.com");
  });

  it("maps empty / 'null' / 'undefined' (any case) and non-strings to null", () => {
    for (const v of ["", "   ", "null", "NULL", " Null ", "undefined", "UNDEFINED"]) {
      assert.equal(normaliseRouteValue(v), null, JSON.stringify(v));
    }
    for (const v of [null, undefined, {}, [], true]) {
      assert.equal(normaliseRouteValue(v), null, String(v));
    }
  });
});

describe("isAbsentValue (pure)", () => {
  it("is the negation of a usable value", () => {
    assert.equal(isAbsentValue("null"), true);
    assert.equal(isAbsentValue(""), true);
    assert.equal(isAbsentValue(undefined), true);
    assert.equal(isAbsentValue("1791172614617005600"), false);
  });
});
