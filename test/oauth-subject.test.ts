import assert from "node:assert/strict";
import test from "node:test";

import { toOAuthSubject } from "../src/identity/oauth-subject.ts";

test("OAuth subject encoding preserves colon-delimited Anyam identity boundaries", () => {
  const subject = toOAuthSubject("owner:qualification:20260808");

  assert.equal(subject, "owner%3Aqualification%3A20260808");
  assert.equal(subject.includes(":"), false);
  assert.notEqual(subject, "owner%3Aqualification%3A20260808:other");
});
