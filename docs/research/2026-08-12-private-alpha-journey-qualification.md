# Private-alpha journey qualification

This qualification is the fixture-backed integration receipt for the Wayfinder
private-alpha gate. It intentionally uses provider-neutral boundaries:

1. A customer-operated Realm is installed with customer ownership, a verified
   passkey owner, and an owner authentication session.
2. A local Git Smart HTTP upstream is placed behind the Anyam gateway. Git
   clone/fetch and an exact Workspace push are exercised; a canonical push is
   denied.
3. An enforceable local agent Workspace runs a declared Action and Verifier.
   The Action output is checked to remain inside the isolated checkout.
4. A Change Revision is bound to the actual Git commit/tree identities and the
   agent Actor/Grant context.
5. The Authority Plane records the Run, Evidence, Artifact, and trusted
   Landing. Canonical mutation is reported as 'landing-only'.
6. A ready immutable Worker Release is previewed and promoted. A deliberately
   unhealthy Release is rolled back, and both health observations are checked
   against the Release identity they measured.
7. A credential-free Project Export is verified, restored into quarantine, and
   owner-activated.

Run it with:

    npm run qualification:private-alpha-journey

The command prints 'anyam.private-alpha-journey-qualification/v1'. Its
'hostingMode' is 'customer-operated-fixture' and its
'providerQualification' explicitly says that live Cloudflare/Artifacts
qualification is separate. This is integration evidence, not a claim about
live provider capacity or production SLOs.

The deterministic test is:

    npm run test:private-alpha-journey

Temporary fixture resources are removed in finally; no credential material is
persisted or printed. Any future numeric limit must carry a new measurement
receipt before it becomes a production tripwire.
