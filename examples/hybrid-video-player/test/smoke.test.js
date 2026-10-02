import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { playerLabel } from "../dist/public-player.js";

test("the public projection contains the player and no private codec", async () => {
  assert.equal(playerLabel(), "public-player");
  const projection = await readFile("dist/public-player.js", "utf8");
  assert.match(projection, /playerLabel/);
  assert.doesNotMatch(projection, /privateCodec|private-codec/);
});
