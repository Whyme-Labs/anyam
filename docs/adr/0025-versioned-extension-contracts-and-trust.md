# Versioned extension contracts and trust boundary

Status: Accepted

## Context

Anyam needs a healthy ecosystem without turning every integration into kernel
code or requiring a marketplace. Repository Drivers, Actions, Verifiers,
Target adapters, project experiences, IDE integrations, coding-agent skills,
and installed Apps have different lifecycle and authority needs.

Issue [#33](https://github.com/wms2537/anyam/issues/33) asked for safe,
versioned contracts covering discovery, packaging, compatibility, sandboxing,
trust, distribution, and deprecation. The logic prototype is preserved on
[`codex/prototype-extension-ecosystem`](https://github.com/wms2537/anyam/tree/codex/prototype-extension-ecosystem)
at commit [`db65f3f`](https://github.com/wms2537/anyam/commit/db65f3f).

The prototype showed that the useful boundary is not a marketplace listing. It
is a signed/digested manifest, a Project-scoped installation, a narrower
Capability Grant, a kernel-owned proposal/commit path, and an explicit
deprecation/revocation lifecycle.

## Decision

Extensions use one open, versioned `anyam.extension/v1` contract with typed
kinds:

```text
RepositoryDriver
Action
Verifier
TargetAdapter
ProjectExperience
IDE integration
AgentSkill
installed App/integration
```

An extension manifest declares:

```text
extension ID and version
kind and API contract
source/distribution reference
content/package digest
kernel compatibility
declared effects and capabilities
trust/provenance information
configuration schema and outputs
deprecation/revocation metadata
```

The manifest describes mechanics and requested effects. It never grants
authority, changes Source Space visibility, approves Evidence, Lands a Change,
or Promotes a Target.

### Discovery and distribution

Distribution is intentionally separate from authority:

- first-party extensions may ship with Anyam;
- verified extensions may be fetched from an owner-controlled package, Git
  repository, registry, or signed release;
- unverified extensions may be inspected or installed only under an explicit
  Realm/Project policy and cannot request high-risk effects by default;
- a catalog is a discovery/read projection, not a trust root or marketplace;
- installations record the exact source, digest, signer/provenance, owner,
  Project/Realm, and policy decision.

Anyam does not require marketplace economics, rankings, or a central listing to
make the extension protocol useful. A customer can distribute an extension
from its own registry or repository and install it by digest.

### Compatibility and packaging

The extension API is semver/versioned and negotiated before installation. The
runtime records the kernel contract, extension contract, package digest,
toolchain/runtime, and provider capability profile. Incompatible, missing-
digest, or malformed manifests are rejected before code execution.

Extensions must use a capability-neutral normalized interface:

```text
input Project View / Snapshot / Artifact / Run contract
  → extension execution
  → normalized result, output digests, declared effects, and attestation
```

Provider mechanics, package format, process sandbox, and external API remain
extension-owned. Anyam owns policy, disclosure, provenance, idempotency,
Evidence normalization, Release/Promotion state, and audit.

### Installation and capability model

An installation is scoped to a Realm/Organization/Project (and, where needed,
Source Space, Target, Action, or Run). Effective authority is:

```text
extension declared effects
  ∩ Realm/Project/Source Space policy
  ∩ installation grant
  ∩ Actor/Task Capability Grant
  ∩ device/network/model conditions
  − explicit denies
```

The intersection can only narrow the manifest. An extension cannot request a
capability that the manifest does not declare, and a grant cannot add an
effect that policy denies.

Examples of effects are `read`, `execute`, `write-artifact`, `secret-use`,
`network`, and `target-promote`. Secret Use means brokered invocation only; raw
secret values remain outside the extension process and model context.

### Kernel authority boundary

Extensions return normalized observations, artifacts, Evidence candidates, or
proposals. The kernel performs the protected transition:

```text
TargetAdapter proposes Promotion
  → Anyam validates Release, Evidence, policy, Target, and expected state
  → trusted Promotion service applies the transition
```

The same boundary applies to RepositoryDrivers, Verifiers, Actions, mirrors,
and Apps. No extension receives canonical repository write, policy-management,
approval, or production-promotion authority merely by declaring or being
granted an effect.

### Trust and execution

Trust is explicit (`first-party`, `verified`, or `unverified`) and does not
replace capability policy. An extension runs in a bounded Runner or provider
adapter with:

- exact disclosed Project View/Snapshot inputs;
- declared network and Secret Use aliases;
- short-lived task/job identity;
- output and Artifact scopes;
- time/resource/cost budget from the active Budget Policy;
- immutable package and toolchain digest; and
- normalized result plus signed/attested provenance.

An unverified extension may be useful for local/read-only experiments, but
cannot request target authority or other high-risk effects without an explicit
reviewed Governance Profile and installation policy.

### Lifecycle

The lifecycle is explicit:

```text
proposed → installed → enabled
                    ↘ deprecated → revoked
                    ↘ blocked
```

- `proposed`: manifest is visible for review; no execution.
- `installed`: package/digest and grant are recorded; policy may still require
  owner approval before enablement.
- `enabled`: new invocations are allowed within the active grant.
- `deprecated`: new installations or invocations are blocked by policy; prior
  Release lineage, Evidence, and audit remain inspectable.
- `revoked`: security or integrity response invalidates the installation and
  future invocations; active Runs are quarantined or cancelled where possible.
- `blocked`: manifest, compatibility, trust, policy, or provenance failure
  prevents activation.

Deprecation and revocation never rewrite accepted source, Evidence, Artifacts,
Releases, or Audit Events. A replacement extension is a new installation with
new compatibility and Evidence.

### Extension classes

#### RepositoryDriver

Transfers/inspects Git data, issues provider credentials through the Git
Gateway, exports/restores objects, and reconciles provider refs. It never
decides Anyam authorization, Source Space disclosure, Project Revision
atomicity, or canonical authority.

#### Action and Verifier

Consume exact declared inputs and return normalized outputs/Evidence candidates.
The kernel validates the Run, input digest, disclosure, freshness, and policy;
an exit code or model explanation is not by itself Evidence.

#### TargetAdapter

Accepts typed Artifacts and performs provider mechanics. It proposes a
Promotion and reports provider state; Anyam owns Release identity, expected
state, health verification, policy, and rollback.

#### ProjectExperience, IDE, and AgentSkill

Provide views, commands, editor integration, or workflow knowledge. They are
not authority surfaces. Instructions are helpful guidance; server-side policy
and capability checks remain mandatory.

#### Installed App

Uses administrator-approved asymmetric installation identity and short-lived
installation credentials. Permissions are resource/effect scoped; shared
administrator tokens and broad PATs are not the integration model.

## Consequences

Anyam can grow an ecosystem of providers and experiences without putting
provider mechanics in the kernel or trusting a marketplace as a security
boundary. Customers can self-distribute extensions, pin digests, audit exact
versions, and revoke them without rewriting Project history.

The cost is that every extension must implement a normalized contract,
provenance, compatibility declaration, and lifecycle. That work is the price
of keeping the next adapter from becoming a silent authority or an unbounded
cost/secret/disclosure path.
