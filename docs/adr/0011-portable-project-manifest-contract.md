# Portable Project Manifest, Action, and Verifier contract

Status: Accepted

## Context

Anyam needs to understand enough of a Project to offer useful checks,
Candidate Outputs, Evidence, Artifacts, and Target Promotions across different
project types. A mandatory hand-written YAML file would make simple Projects
slow to start and would force agents to infer conventions that the host
ecosystem already makes obvious. A completely implicit system would make
Actions, Verifiers, and Target adapters impossible to review or reproduce.

Issue [#19](https://github.com/wms2537/anyam/issues/19) asked for a minimal,
portable contract covering modules, dependencies, Actions, environments,
inputs, outputs, caches, networks, resources, Verifiers, Artifact types, and
Target adapters, while preserving zero-config detection, explicit
configuration, schema evolution, local/remote parity, and the Cloudflare
Worker plus Rust CLI reference Projects.

The contract was exercised in the throwaway prototype on branch
[`codex/prototype-project-manifest-contract`](https://github.com/wms2537/anyam/tree/codex/prototype-project-manifest-contract),
commit `877bfaf`. The owner accepted its behavior in ticket [#19](https://github.com/wms2537/anyam/issues/19).

## Decision

### The canonical object is a versioned Project Manifest

Anyam uses a versioned semantic Project Manifest. Its first contract identifier
is `anyam.project/v1`. JSON is the canonical interchange shape; YAML, TOML,
JSON, or another repository-friendly serialization may represent the same
document. No serialization is mandatory for a Project that can be understood
from conventions.

The minimum v1 semantic shape is:

```text
Project Manifest
├── project identity and reference type
├── source signals and configuration provenance
├── modules
│   ├── root
│   ├── dependencies
│   ├── Actions
│   │   ├── command
│   │   ├── declared inputs
│   │   ├── outputs
│   │   ├── network destinations
│   │   └── resource requirements
│   └── Artifact types
├── Verifiers
│   ├── Action binding
│   ├── disclosure policy
│   └── required-for declarations
└── Target adapter declarations
    ├── adapter identity
    ├── accepted Artifact types
    └── required capabilities or checks
```

The manifest describes declared project mechanics and relationships. It does
not claim that a Project is functional, complete, safe, or universally
buildable. Those claims require Runs, Verifiers, Evidence, policy, and owner
review.

### Convention detection is a proposal, not hidden authority

For a Project without explicit configuration, Anyam detects familiar signals
such as `package.json`, `wrangler.jsonc`, `Cargo.toml`, `Cargo.lock`, source
roots, and ecosystem conventions. Detection produces a normalized Manifest
Draft with visible provenance:

```text
schema: anyam.project/v1
source: detected from package.json, wrangler.jsonc, src/index.ts
configuration: convention-derived
```

Detection is deterministic for the same disclosed source Snapshot and detector
version. It never silently invents a hidden repository file, grants access,
or asserts that inferred commands are correct. Ambiguous or conflicting
detection is surfaced for review and does not become an unmarked Project
contract.

The initial reference detections are:

- Cloudflare Worker: source package metadata, Wrangler configuration, and
  TypeScript source produce `check`, `build`, a Worker Artifact type, a public
  contract Verifier, and a Cloudflare Target adapter.
- Rust CLI: Cargo metadata and source produce locked test/build Actions,
  executable and archive Artifact types, a CLI smoke Verifier, and a generic
  release-assets Target adapter.

Additional detectors are extensions, not new kernel semantics.

### Explicit configuration overlays detected defaults

An owner may commit an explicit Project Manifest or a focused configuration
overlay when conventions are insufficient. The overlay is versioned Project
content and becomes part of the Change and Evidence inputs.

The precedence is:

```text
disclosed source conventions
  → detected Manifest Draft
  → explicit owner configuration
  → Realm policy and Capability Grants
  → runner and Target adapter mechanics
```

An explicit value overrides the corresponding detected value; it does not
silently discard unrelated detected modules, Actions, outputs, or policies.
Conflicts and unknown fields are reported with their source and required
remediation. A Project may use only conventions, only explicit configuration,
or both.

Project configuration never grants access or bypasses policy. A manifest may
declare a network destination or resource requirement, but the policy engine
and Capability Grant decide whether a Run may use it.

### Actions are portable declarations, not runner scripts with authority

An Action declares how to transform exact inputs into named outputs. Its
normalized contract includes:

```text
module + action name
command or action implementation reference
input globs and dependency inputs
output paths or typed output names
network destinations
resource requirements
```

Actions run against immutable source and declared inputs. Caches are optional
derived inputs and never replace the exact input binding required for
reproducibility. Secrets are referenced through Secret Use capabilities and
never placed in the manifest as values.

Local and remote execution consume the same normalized Action contract. The
execution mode selects a permitted runner; it does not change the command,
inputs, outputs, network declaration, resource declaration, or contract
digest. A local and remote plan for identical inputs therefore has the same
semantic contract even when the runner mechanics differ.

The manifest does not encode a universal resource quota. Resource values are
declared requirements or detected values until the execution and cost work
provides a receipt. Any enforced budget must be named in the resulting
Policy Explanation or Run failure with its configured limit and requested
amount.

### Verifiers are declared assertions over Actions and Runs

A Verifier binds to a declared Action or Run and states what Evidence it can
produce, who may see it, and for which Release or Target decisions it is
required. `full` and `result-only` are disclosure policies in the prototype;
Sealed Verifiers are the restricted extension already defined by ADR 0004.

The manifest declares the Verifier contract. The Run records the exact source,
Project Revision, Action, toolchain, dependencies, inputs, and verifier version;
Evidence freshness and policy invalidation remain governed by the Evidence
model. A Verifier declaration does not make its result true and does not
automatically block or permit Landing or Promotion without policy.

### Target adapters declare accepted outputs and requirements

A Target declaration names an adapter, the Artifact types it accepts, and
required capabilities or checks. The adapter owns provider mechanics; Anyam
owns the immutable Release, provenance, disclosure, policy, Promotion, and
audit contract.

Environment-specific details belong to the Target and its adapter rather than
to a second incompatible manifest model. A Cloudflare Worker Target, package
registry, release-assets channel, device cohort, or other destination can share
the same Project Manifest boundary while exposing adapter-specific fields
through a versioned extension.

### Schema evolution is explicit and reviewable

Every manifest declares its schema identifier. Migrations are versioned pure
transformations that return:

```text
normalized Manifest
warnings
unmapped or ambiguous fields
source schema and destination schema
```

The prototype maps a small `anyam.project/v0` shape into v1 and emits warnings
when legacy checks become Verifiers or a legacy deploy field becomes a Target
adapter. Migrations never silently assert disclosure, policy, health, or
reproducibility semantics that the old schema did not contain. Ambiguous
migrations require owner review before the migrated document can be used for
Landing, Release creation, or Promotion.

Unknown fields must be preserved or surfaced according to the schema's
forward-compatibility rule; they must not be silently dropped. Schema and
detector versions are part of Run and Evidence provenance.

## Consequences

- A simple Project can start from detected conventions without a mandatory
  `anyam.yaml` file.
- Technical users and agents can inspect one normalized contract instead of
  reverse-engineering each ecosystem's commands.
- Explicit configuration remains reviewable, versioned, and local to the
  Project rather than hidden in the service.
- Local, Cloudflare, and external runners can share Action semantics while
  retaining provider-specific execution adapters.
- Verifiers and Target adapters extend the platform without putting scanner,
  registry, cloud, or device mechanics into the kernel.
- Schema migrations become visible Change inputs with warnings and provenance,
  rather than silent compatibility magic.
- The contract intentionally does not promise that a detected or declared
  Action succeeds; Runs and Evidence carry those claims.

## Rejected alternatives

- **Mandatory YAML before the first Run:** creates ceremony and blocks simple
  Projects that already have clear ecosystem conventions.
- **Pure convention inference with no explicit manifest:** makes advanced
  behavior invisible, hard to review, and difficult to reproduce.
- **One runner-specific workflow format:** couples the Project model to
  Cloudflare, Linux, or a particular CI product and breaks local/remote parity.
- **Manifest as an authorization document:** source declarations cannot grant
  network, secret, repository, or Target authority; Realm policy and
  Capability Grants remain authoritative.
- **A universal claim that the Project “works”:** correctness and completeness
  are owner- and Project-specific assertions produced by Verifiers and Evidence,
  not a property Anyam can define for every project type.
- **Silent schema migration:** destroys provenance and can change release or
  security meaning without an explicit reviewable Change.

