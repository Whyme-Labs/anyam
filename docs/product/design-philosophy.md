# Anyam design philosophy

Anyam keeps source control familiar while making the authority behind delivery
explicit. These rules guide the product, the CLI, the customer Realm, and the
documentation.

## Keep Git honest

Repositories, commits, branches, tags, clone, fetch, push, diff, and merge keep
their Git meanings. Anyam adds a term only when the Project needs a meaning Git
does not own.

A Pull Request is a compatibility view over a Change. A merge can participate
in Landing. A check summarizes Evidence. None of these views replaces the
underlying object.

## Put the Project above one repository

A Project can contain several repositories, Source Spaces, modules, Artifacts,
Releases, and Targets. A repository stores Git objects. It does not decide
which source is visible, who may change it, or what may reach production.

## Make disclosure structural

Public and private source live in separate Source Spaces. A public Project View
contains a real public Git lineage. It does not contain private objects, paths,
identifiers, history, or activity.

Anyam verifies disclosure integrity. It does not claim that every public
projection is functionally complete. The Project owner declares what a profile
contains and what its checks prove.

## Separate editing from authority

An editor or coding agent works in an isolated Workspace. The agent can publish
a Change Revision, but it cannot write canonical Project state. Landing checks
policy, review, and Evidence before the canonical revision moves.

Build, Release, and Promotion remain separate:

```text
Build → Artifact
Artifact + Evidence + policy → Release
Release + Target → Promotion
```

Production receives the exact verified Artifact. It does not rebuild a branch
and call the new output the reviewed Release.

## Treat Evidence as a claim with a receipt

A Run uses exact source, dependency, toolchain, environment, and policy inputs.
It produces Evidence with a digest and a validity rule. A green badge, agent
summary, or human assertion is not Evidence by itself.

Measure production capacity and performance tripwires against healthy workloads
and preserve the receipt. Provider, protocol, security and policy limits retain
their governing source and meaning. Fixture values do not establish production
capacity, and healthy traffic does not authorize raising a policy threshold.

## Give every actor narrow authority

The authority chain is explicit:

```text
Principal → Actor → Session → Task → Capability Grant
```

Human and agent operations use the same policy model. Credentials have an
audience, a resource, an operation, and an expiry. A source read does not imply
model-processing permission. A provider credential does not grant Project
authority.

## Stay open and portable

The first-party source is available for review; a distribution license remains
to be selected. Customer-operated mode runs in
the customer's Cloudflare account, and Project history remains exportable if a
provider changes or disappears.

Cloudflare is the default implementation, not the only intelligible format. Git
objects, manifests, Evidence indexes, and exports remain documented and
versioned.

## Prefer the obvious path

The routine path should be clear to a developer and to an agent:

```text
create or import → inspect → change → verify → review → land → release → promote
```

When policy blocks an operation, the error names the rule, the current state,
the missing requirement, and the next permitted action. A disabled control with
no explanation is a product bug.

## Read the source decisions

This page summarizes the [Product Constitution](constitution.md). The [platform
blueprint](../blueprint/anyam-platform-blueprint.md) and [architecture decision
records](../adr/) contain the implementation detail.
