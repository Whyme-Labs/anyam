---
status: accepted
---

# GitHub Actions Bridge outbound Mirror synchronization

The outbound direction is a pull-based customer workflow. Anyam does not hold
a GitHub credential and never asks the workflow to provide one to the Realm.
The workflow exchanges an outbound OIDC capability, retrieves one signed
bundle for the exact Project, Source Space, Repository Mirror, and run, pushes
with its job-scoped `GITHUB_TOKEN`, and reports provider read-back.

The outbound bundle includes:

- the exact canonical refs and local-to-remote ref mapping;
- the expected remote generation and mapped remote refs;
- object format, default branch, and bundle bytes/digest/byte count;
- Mirror, Project, Source Space, repository, capability, and run identity;
- an Ed25519 signature over the complete manifest and bundle digest.

The Realm verifies the signature and digest before returning a push plan. The
workflow is responsible for invoking GitHub's ordinary protected-branch
rules; a protected-branch refusal is returned as a blocked Mirror checkpoint
with explicit mirror-branch or Pull Request recovery. A provider read-back
that differs from the signed desired refs is quarantined, never reported as a
healthy synchronization.

`no-run`, stale, disabled, revoked, expired, and replayed operations are
visible fail-closed states. A successful operation consumes its operation
identity exactly once; failed provider or checkpoint attempts can resume the
same immutable operation. The customer-owned Realm persists completed outbound
operation identities.

The generated workflow documents that Anyam CI remains authoritative unless a
customer explicitly opts into this reusable projection. Pushes made with
`GITHUB_TOKEN` do not recursively trigger the workflow; no recursive workflow
assumption is part of the protocol.

Live GitHub API, protected-branch, and provider upload qualification remain
separate receipts. Missing customer-owned outbound service bindings block the
operation before any GitHub push.
