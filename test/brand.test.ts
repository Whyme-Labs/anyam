import assert from "node:assert/strict";
import test from "node:test";

import { ANYAM_BRAND, ANYAM_BRAND_CSS, ANYAM_BRAND_MARK_DATA_URI, anyamBrandLockup, anyamBrandStyleTag } from "../src/brand.ts";

test("Anyam brand tokens match the supplied kit", () => {
  assert.deepEqual(ANYAM_BRAND.colors, {
    ink: "#0A0A0A",
    slate: "#6B7280",
    mist: "#F2F4F7",
    accentBlue: "#2563EB",
    white: "#FFFFFF",
  });
  assert.equal(ANYAM_BRAND.clearSpace, "inner-loop-height");
  for (const token of ["--anyam-color-ink", "--anyam-color-slate", "--anyam-color-mist", "--anyam-color-accent-blue", "--anyam-font-sans", "--anyam-font-mono"]) assert.match(ANYAM_BRAND_CSS, new RegExp(token));
  assert.match(ANYAM_BRAND_CSS, /anyam-dark-surface/);
});

test("brand HTML is self-contained for customer-owned Workers", () => {
  assert.match(ANYAM_BRAND_MARK_DATA_URI, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
  assert.match(anyamBrandStyleTag(), /<style>/);
  assert.match(anyamBrandLockup(), /class="anyam-lockup"/);
  assert.match(anyamBrandLockup("inverse"), /anyam-lockup-inverse/);
  assert.match(anyamBrandLockup(), /data:image\/png;base64/);
});
