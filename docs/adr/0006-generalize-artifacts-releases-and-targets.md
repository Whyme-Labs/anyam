# Generalize Artifacts, Releases, and Targets over adapter contracts

Status: Accepted

## Context

Anyam must deliver more than web applications: packages, command-line binaries, documentation, infrastructure plans, models, datasets, mobile builds, firmware, and device releases all need a trustworthy path from source to an externally visible result. A kernel that calls every result a deployment would either become web-specific or conceal important differences in registry, store, fleet, and stateful infrastructure behavior.

The owner resolved the kernel-versus-adapter and delivery semantics in ticket [#14](https://github.com/Whyme-Labs/anyam/issues/14).

## Decision

1. The universal lineage is `Candidate Output → Artifact → Release → Target → Promotion`.
2. A Candidate Output is disposable and linked to a Change Revision. It may be a preview, test package, rendered document, model playground, plan, or simulator result, but it is never directly promotable.
3. An Artifact is immutable, content-addressed, typed by an extensible versioned schema, and bound to exact source and execution provenance. Its access policy is independent from source access. An imported or externally built Artifact is accepted only through explicit attestation and remains marked as externally produced.
4. A Release is an immutable, named manifest containing one or more typed Artifacts, configuration references and digests, and Evidence. Release names are Project-defined; Anyam assigns immutable identity. Secret values never enter a Release.
5. A Target is a stable destination or channel with declared capabilities, policy, current Release pointer, health state, and append-only Promotion history. Targets may be runtimes, registries, stores, device cohorts, publication channels, or other adapter-owned destinations.
6. One Release may be promoted independently to many Targets. Target-specific overlays resolve during Promotion, and a Target may require an Anyam-reproducible Build, verified signing, or other policy even when another Target accepts an attested external Artifact.
7. A Promotion is an explicit state machine with idempotency, an expected-current-Release guard, adapter execution, declared health verification, and clear success, failure, or indeterminate outcomes. Anyam refuses to promise capabilities the Target adapter does not declare.
8. Releases never mutate. Rollback is a new Promotion to a previous known-good Release and requires Target-specific Evidence that external state remains compatible. Application, data, schema, infrastructure, and other state changes are separate Artifacts or Evidence; rollback never silently rewinds external state.
9. Signing and attestation requirements are policy-configurable. Anyam normalizes signer identity, verification status, and provenance without imposing one universal cryptographic scheme.
10. The kernel owns Artifact/Release/Target contracts, provenance, disclosure, authorization, policy, normalized adapter results, Promotion state, and audit. Open, versioned adapters own project-type and provider mechanics such as build, package, deploy, health, and provider-specific rollback. Adapters cannot grant themselves source access, Secret Use, approval, or Promotion authority.
11. Candidate, Artifact, Release, and Promotion records use Disclosure Projections so public delivery views cannot leak private inputs, customer identifiers, internal Targets, or restricted Evidence.
12. Promotion approval and signing use Progressive Ceremony. A solo Project may use a direct policy path; teams, sensitive Artifacts, and protected Targets may require review, Evidence, signatures, or separation of duties.

## Consequences

- Cloudflare Workers, package registries, app stores, model registries, documentation channels, and device fleets can share one kernel without pretending they have identical semantics.
- The kernel must preserve adapter capability declarations and explain unsupported operations instead of exposing a generic “deploy” button that lies.
- Release and Target state is separate from source and Build state, so an already verified Artifact can move through Targets without rebuild drift.
- External CI and customer-owned build systems remain first-class through attestation, while policy can require reproducible Anyam Builds for sensitive Targets.
- Target adapters and Artifact schemas become a public extension surface with lifecycle, permission, and provenance requirements.
- Rollback correctness depends on external state Evidence. A previous application Artifact alone cannot prove that a database or device fleet can safely accept it.

## Rejected alternatives

- **Deployment as the universal output**: excludes libraries, models, documents, data, firmware, and registries or forces web assumptions into the kernel.
- **One Artifact per Project**: cannot represent multi-platform packages, migration bundles, SBOMs, provenance, or multi-component Releases.
- **Mutable Release records**: destroys auditability and makes Target history non-reproducible.
- **Rebuild on every Promotion**: creates drift between verified and delivered outputs.
- **Universal rollback promise**: many Targets are append-only or stateful; unsupported capabilities must remain explicit.
- **Anyam-owned implementation of every provider engine**: creates an unbounded maintenance surface and obscures the trust/control-plane boundary.
