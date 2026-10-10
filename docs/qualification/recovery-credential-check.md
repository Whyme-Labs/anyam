# Recovery credential detection contract

Recovery verification uses `anyam.credential-material-scanner/v1`, the existing
shared scanner in `src/security/credential-material.ts`. The supported input is
a stable JSON Recovery bundle. Producers must exclude every credential and
secret; the scanner is an additional check, not an exhaustive secret detector.

The detection contract covers:

- Sensitive field names recognized by the shared scanner, such as `apiKey`,
  `accessToken`, `refreshToken`, `clientSecret`, `privateKey`, `authorization`
  and `credentials`. Key normalization applies Unicode NFKC, removes non-ASCII
  alphanumeric separators, and ignores casing. Objects and arrays are visited
  recursively. Known sensitive keys are rejected for non-marker values,
  including objects and nulls.
- Recognizable text shapes: authorization/Bearer and Basic headers, assignment
  text, JWT shapes, private-key PEM headers, the scanner's enumerated provider
  token formats, and URLs containing user/password information.
- A single valid URI or whole-string Base64/Base64url decoding layer when the
  decoded string contains a recognized form. This does not promise recursive
  decoding, arbitrary embedded binary inspection, or encrypted-content analysis.
- The shared scanner's explicit redaction/absence markers, including `redacted`,
  `not-issued`, `not-printed`, `none` and `missing`, are valid marker controls.
  Other Realm schema rules still apply: this allowance never restores Sessions,
  Grants or credential records, nor permits a credentials collection where the
  Recovery schema forbids one.

Verification, export and storage report the scanner protocol and
`credentialScanScope=known-patterns; exhaustive=false`. Verification and object
receipts also carry structured `credentialMaterialCheck` with `status=detected`
or `not-detected`. The existing `credentialFree=true` bundle/object field is a
producer declaration checked against the supported contract; it is retained for
compatibility and must be read with the check's scope. R2 metadata records the
same scanner and coverage limitation. A verified Recovery bundle remains
quarantined on restore until provider reconciliation and owner activation.

Detected known material produces a fixed failure and safe category before any
storage write or restore transition. Diagnostics omit matched values, untrusted
scanner paths and bundle identifiers. Reading an already retained violating
object also rejects it without deleting or repairing its bytes.

Limitations are explicit: opaque secrets under unrelated names, unsupported
formats, repeated encodings, or secrets equal to allowed marker strings may not
be recognized. Conservative patterns can also reject benign data. An accepted
opaque string demonstrates only that known patterns were not detected. This
scanner does not validate whether a credential is live, approve retention of
unknown secrets, or establish a production storage/security qualification.

Run the focused tests from the repository root:

```sh
npx tsx --test test/customer-realm-recovery-credentials.test.ts test/customer-realm-recovery-object.test.ts test/customer-realm-persistence.test.ts test/customer-realm.test.ts test/customer-realm-control.test.ts test/credential-material.test.ts
```

The regression fixtures use fabricated markers only. They cover alias/case and
nested forms, recognized text/encoding, zero-write and unchanged-restore denial,
safe diagnostics, redaction controls, scope receipts and an explicitly accepted
opaque-data limitation. These are local contract tests. The separate full gate
and actual R2 runtime test require their own shared-host validation slot.
