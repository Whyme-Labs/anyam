# Anyam Initial Market Wedge

Status: Ratified by the owner on 2 August 2026

This document defines Anyam's initial customer, users, job-to-be-done, adoption trigger, replacement boundary, reference workflows, and measurable proof of product value. It operates within the commitments in the [Anyam Product Constitution](constitution.md).

## Wedge in one sentence

Anyam initially serves small, technically led software teams that are moving coding agents from occasional assistance into sustained production work and need a customer-operated, Git-compatible system that gives every human and agent narrow authority from Change through Release.

## Initial buyer

The initial economic buyer is a technical founder or engineering lead at a 2–20 person software company or agency that:

- already uses Codex, Claude Code, Cursor, or comparable coding agents;
- runs at least part of its product or delivery stack on Cloudflare;
- expects humans and multiple agents to work on production-relevant source;
- considers broad repository credentials and direct canonical writes unacceptable;
- values operating the canonical source and delivery control plane in its own Cloudflare account; and
- may need public, private, internal, or restricted source to coexist within one Project.

An agency is a particularly strong example because it must keep client Projects, credentials, source visibility, agent authority, and release approval separate while using a repeatable operating model across clients.

The first buyer is not a large regulated enterprise. Such organizations may eventually benefit greatly from Anyam, but their procurement, certification, identity, residency, and legacy-integration requirements would distort the first product before its core value is proven.

Solo developers are first-class users and the lowest-friction adoption path. They are not the initial commercial buyer because the first paid value is clearest when coordination, delegation, ownership, and governance extend beyond one person.

## Primary and secondary users

### Primary: technical builders

Anyam is designed primarily for technical builders: software developers, technical founders, engineering leads, and developer-platform engineers who own source, system behavior, and delivery outcomes.

They need direct access to Git, local files, diffs, checks, logs, policies, credentials, source boundaries, Releases, and operational state. They may work manually, delegate an entire Change to a coding agent, or alternate between both. Anyam must not hide its source and trust model from them behind a prompt-only abstraction.

Their daily experience is centered on:

- local Workspaces in their existing editors and terminals;
- ordinary Git operations where Git terms are exact;
- the Anyam CLI and agent integrations;
- stable Changes and immutable Change Revisions;
- review of source, effects, checks, and Evidence; and
- policy-controlled Landing, Release, and Promotion.

### Secondary: guided builders

Non-technical builders are a first-class secondary audience. Coding agents and guided workflows should let them describe an outcome, inspect a candidate, provide feedback, approve permitted costs or effects, and ship low-risk work without first learning Git.

This accessibility must come from good automation and progressive disclosure, not from hiding safety boundaries. Anyam must still present material source visibility, cost, data, security, and release implications in understandable language. Project policy may require a technical owner or specialist approval for high-risk Changes.

The intended expansion is therefore from a technically grounded source-control system toward a broadly usable building system—not from a prompt-to-app product toward source control after the fact.

## Job to be done

When a small team begins using several coding agents on real shared source, it needs to:

> Give every human or agent an isolated place to make a bounded Change, grant only the source and tools required for that Task, verify the exact result, and move approved Artifacts to a Target without exposing private source, production credentials, or canonical write authority.

The complete job includes:

1. Create or import a Project without first assembling a forge, CI service, credential system, and deployment pipeline.
2. Work locally with normal Git, editors, terminals, and any supported coding agent.
3. Compose only the Source Spaces an Actor and model provider may access.
4. Publish immutable Change Revisions without direct writes to canonical repositories.
5. Produce revision-addressed checks, Evidence, previews, packages, or other candidate outputs.
6. Review the source and complete Project effect, not only a textual diff.
7. Land approved Changes through trusted Anyam authority.
8. Build immutable Artifacts, form a Release, and promote those exact Artifacts.
9. Retain attributable authority, agent context, verification, release, and rollback history.
10. Export and restore the entire Project without relying on an Anyam-operated SaaS or another forge.

## Adoption trigger

The urgent trigger is the transition from occasional AI assistance to sustained, concurrent agent work on shared, production-relevant source.

Before that transition, a developer may tolerate an agent using their local checkout, personal forge token, and ordinary branch or pull-request workflow. Once multiple agents and humans produce real Changes, those shortcuts create visible problems:

- repository credentials are broader and longer-lived than the Task;
- agents compete for branches, working directories, and shared mutable state;
- the team cannot reconstruct exactly what source, context, model, tools, and permissions produced a Change;
- public and private source require fragile split-repository automation;
- checks become green indicators without reproducible Evidence;
- source merge, Artifact creation, and production Deployment are easily conflated; and
- canonical source and release authority remain concentrated in credentials held by humans, agents, or external platforms.

The buying moment is therefore:

> We are ready to let multiple agents ship real work, but we are not willing to give them broad forge credentials or lose control of source, evidence, and production.

Hybrid-source development and customer-operated Cloudflare hosting strengthen the decision, but neither should obscure this immediate agent-production trigger.

## Adoption motion

Anyam should be adopted one Project at a time rather than requiring an organization-wide forge migration.

A team may:

- create a new Project directly in Anyam;
- import an active repository and make Anyam canonical for new Changes;
- begin with a fully private or open-source Project before introducing multiple Source Spaces; or
- keep an existing forge as a temporary mirror during evaluation.

The first useful outcome must not depend on migrating every repository, issue, package, workflow, or organization policy. Once one Project proves the model, the same Realm can add more Projects without redeploying a separate forge per application.

The open-source product creates the solo and community adoption funnel. Customer-operated installation, team collaboration, managed upgrades, support, and execution capacity create the path to commercial adoption without withholding product capabilities.

## Initial replacement boundary

For a Project made canonical in Anyam, the first credible product owns the complete critical path:

- Git repository creation, import, clone, fetch, push, and export;
- identity, Project membership, Source Space access, and Capability Grants;
- local and remote Workspaces;
- Intents, Changes, Change Revisions, review, and approval;
- checks, Runs, Evidence, and candidate outputs;
- trusted Landing and canonical Project Revisions;
- Artifact creation and storage;
- Releases and protected Targets;
- Deployment where a Target is a runtime;
- audit, provenance, revocation, rollback, and Project Export; and
- stable CLI, API, MCP, webhook, and event interfaces.

This path must work in a Customer-operated Realm without GitHub, GitLab, another forge, or an Anyam-operated SaaS.

The initial product does not attempt to own:

- broad portfolio and enterprise project management;
- team chat and general document collaboration;
- every ecosystem-specific package registry;
- proprietary app-store and device-fleet control planes;
- every SAST, DAST, dependency, fuzzing, or malware-analysis engine;
- GitHub-scale social discovery, sponsorship, and marketplace economics;
- a proprietary coding model; or
- a proprietary general-purpose browser IDE.

These remain integrations, Verifiers, Targets, mirrors, or later ecosystem capabilities. An existing forge may be an import source, migration bridge, or optional public mirror, but never a required dependency of the canonical Project path.

## Reference workflow A: hybrid-source Cloudflare application

The first reference Project is a TypeScript Cloudflare application containing:

- a public UI, SDK, and public contracts;
- a private implementation Source Space;
- at least one stateful Cloudflare resource such as D1 or a Durable Object;
- a secret-backed external integration used through Secret Use;
- local and remote coding-agent Workspaces;
- a Change spanning public and private source;
- public checks plus a Sealed Verifier;
- a preview Deployment;
- a database or state compatibility decision;
- a Release containing immutable verified Artifacts; and
- policy-controlled Promotion to production.

This Project proves Anyam's main differentiation: one coherent Change and release history across independently protected source, human and agent Actors, Evidence, and a customer-owned Cloudflare runtime.

The particular application theme is not constitutional. It may use a public player with a private codec or another public-contract/private-implementation design, provided it exercises the same source and trust boundaries without turning the demo's business domain into an Anyam assumption.

## Reference workflow B: open-source Rust CLI and library

The second reference Project is a fully open-source Rust library and command-line tool containing:

- ordinary public Git clone, fetch, branch, commit, tag, and contribution workflows;
- a local-first Workspace and offline inner loop;
- human and coding-agent Changes;
- stacked or dependent Changes;
- Linux, macOS, and Windows checks through default and pull-based runners;
- library and executable Artifacts;
- API compatibility, unit, integration, and smoke-test Evidence;
- a versioned package plus signed downloadable binaries; and
- registry or release-download Targets rather than a live application Deployment.

This Project proves that Anyam's Change, Evidence, Artifact, Release, and Target model generalizes beyond Cloudflare web applications.

## Measurable proof of the wedge

The initial wedge is validated by real canonical usage, not repository count, account creation, or an agent opening a pull request.

One validation cohort must contain a 3–10 person team that can:

1. Create or import one real Project.
2. Connect its preferred coding agents.
3. Produce the first checked Change Revision, candidate Artifact, or preview within 30 minutes of beginning the guided setup.
4. Use Anyam as the sole canonical forge for that Project for 30 consecutive days.

During the 30-day canonical-use period:

- at least two different coding-agent products complete real Changes;
- at least 25 Changes are landed;
- every Landing is attributable to its Principal, Actor, Session, Task, review, policy decision, and required revision-addressed Evidence;
- no human or coding agent receives canonical repository write credentials;
- at least one Release is produced and promoted through Anyam without another forge in the critical path;
- public and private source remain undiscoverable across their declared boundary when the Project is hybrid-source; and
- the team exports and restores the complete Project history using documented formats and a clean Realm or recovery environment.

The decisive business signal is that the team elects to retain Anyam as the canonical system after the trial. Failure to retain it must be investigated as a product failure even if all technical acceptance checks passed.

## Positioning guardrails

The initial positioning is not:

- "another GitHub clone";
- "an AI that writes your application";
- "a Cloudflare deployment dashboard";
- "Git hosting with an MCP endpoint";
- "enterprise DevSecOps for every company"; or
- "a no-code app builder."

The initial positioning is:

> The customer-operated source and release control plane for teams shipping real software with humans and any coding agent.

Any later positioning may broaden the audience, but it must preserve technical control, agent independence, Source Space isolation, Evidence, and complete Project ownership.
