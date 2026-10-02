import test from "node:test";
import assert from "node:assert/strict";
import { formatRelease, greet } from "../dist/index.js";

test("the library exports a deterministic greeting", () => {
  assert.equal(greet("Anyam"), "Hello, Anyam");
});

test("the release asset has a stable version label", () => {
  assert.equal(formatRelease("0.1.0"), "anyam-example 0.1.0");
});
