# Anyam Product Constitution

Status: Ratified by the owner on 1 August 2026

This constitution defines the product promises and boundaries that every Anyam design, roadmap, and implementation decision must preserve. The canonical meanings of capitalized domain terms live in [`CONTEXT.md`](../../CONTEXT.md).

## Product thesis

Anyam is an open, Git-compatible project SCM that lets humans and coding agents transform independently governed Source Spaces into verified Project Revisions and Releases without exposing inaccessible source or granting broad canonical authority.

Anyam manages a Project from source through change, verification, release, and promotion. It is not merely a Git server, a GitHub-compatible web interface, a CI service, a deployment platform, or a coding agent. Those are compatibility surfaces or capabilities within the larger Project model.

## 1. The complete product is open source

Every first-party component required to operate full Anyam must be open source. Anyam must not reserve product capabilities for a proprietary enterprise edition. Commercial offerings may operate the same system, provide support, manage upgrades, supply execution capacity, or deliver professional services, but they must not make the open product deliberately incomplete.

An Anyam Project may be open-source, hybrid-source, or closed-source. The licensing and disclosure choices of Projects hosted by Anyam do not change the licensing promise of Anyam itself.

## 2. The Project is the root managed object

A Project represents the logical body of work: a product, system, library, command-line tool, model, dataset, document set, infrastructure definition, firmware project, or another project type. It may contain several repositories, Source Spaces, modules, build outputs, Releases, and Targets.

A repository remains a real Git repository and must behave as such, but it is a source-storage and object-transfer boundary rather than the complete collaboration model. Anyam must not assume that one repository equals one Project or one deployable application.

Anyam uses familiar Git words whenever they are exact. Commits, branches, tags, clone, fetch, push, diff, and merge retain their ordinary meanings. Anyam introduces terms such as Change, Project Revision, Landing, Evidence, and Promotion only where the semantics exceed Git.

## 3. Source disclosure is structural, not cosmetic

A Project may divide source into independently governed Source Spaces. Each Source Space has its own version history, visibility, access, licensing, and model-processing policy. An Actor may receive a composed Project View of every Source Space they are authorized to use.

Source outside an Actor's authority must be unreachable and undiscoverable. A public clone must not contain private objects or leak private paths, identifiers, commit metadata, contributor activity, search entries, timing, notifications, or semantic-index data. A permission error over an otherwise discoverable private object is not sufficient isolation.

A public Project View is a genuine, Git-compatible source lineage. An authorized internal Project View may compose the same public source with proprietary components. For example, a public video-player clone may omit a private codec while an authorized commercial profile contains both.

Anyam enforces disclosure integrity, not a universal definition of whether a source projection "works." Project owners declare Project Profiles and the builds, checks, outputs, and policies that each profile claims. Anyam verifies those declared claims without forcing every public projection to reproduce a private product.

Moving source from a more restricted lineage to a less restricted one is a Publication Change, never a reversible visibility toggle. Publication must account for history, secrets, licenses, dependencies, metadata, and the permanence of previously disclosed source.

## 4. Collaboration is Change-centric and Git-compatible

A Change has a stable identity across revisions, rebases, and participating repositories. Each Change Revision is immutable and identifies exact Git commits or other Source Space Snapshots. A branch may carry work and a pull request may present the review experience, but neither replaces the stable Change identity.

A Project Revision atomically identifies the exact source state across all participating Source Spaces. A Change may therefore update public source, private source, internal configuration, and restricted verification together without exposing every part to every reviewer.

Conflicts are durable, inspectable state. Text, symbol, contract, schema, dependency, infrastructure, behavior, intent, visibility, and policy conflicts remain explicit until a new Change Revision resolves them. Anyam must never silently accept an AI-generated conflict resolution.

## 5. Canonical source changes only through trusted Landing

Humans and coding agents publish Change Revisions from isolated Workspaces; they do not receive direct write authority over canonical Project state. A trusted Anyam authority performs Landing only after applicable policy, review, and Evidence requirements are satisfied.

This invariant applies to solo developers as well as teams. A one-command solo workflow may perform the required steps immediately, but it must not bypass them or turn a broad personal credential into canonical write authority.

## 6. Humans, agents, and services share one authority model

A human, coding agent, and automation service are all Actors operating through the same Change model. Actor type never implies permission.

Authority must preserve the chain from Principal to Actor to Session to Task. An Actor receives a narrow, temporary, audience-bound Capability Grant describing the Project, Source Spaces, Change, Workspace, tools, networks, secret uses, budgets, effects, and duration it may exercise. Explicit denial wins.

Repository transfer, semantic agent operations, build execution, installed integrations, and release promotion must use credentials with separate audiences and lifetimes. One token must not become universal authority, and a token issued to one Realm must not work in another.

Permission to read source does not automatically permit a model provider to process it. Each Source Space may restrict eligible agent runtimes or model providers. Permission to use a credential-backed service does not imply permission to read the credential value. Sealed Verifiers may expose permitted results without exposing restricted implementation, inputs, or raw traces.

Anyam provides stable, machine-readable interfaces for agents, while Git remains the source-object transport. An agent skill may teach the workflow, but instructions are not a security boundary; the Realm enforces authority server-side.

## 7. Local work stays fast and progressively governed

The routine edit, snapshot, diff, undo, and check loop must work locally without continuous access to a Realm. Network publication, shared verification, review, Landing, and Promotion occur when collaboration or external effects require them.

Solo and team Projects use the same domain objects. Policy progressively adds review, Evidence, separation of duties, and approval as collaboration and risk increase. Anyam must not impose self-assignment, self-review, mandatory pull requests, or deployment ceremony where policy does not require them.

Simple Projects use Git and ecosystem conventions with sensible detection. Explicit, versioned configuration appears only when behavior cannot be inferred safely or an owner wants to override the default. Advanced capability must remain expressible without making a manifest a prerequisite for basic use.

Whenever policy blocks an operation, Anyam must provide a human- and machine-readable explanation of the relevant rule, current state, missing requirement, and permitted next action. An unexplained disabled button or opaque authorization failure violates the product promise.

## 8. Verification produces Evidence, not confidence theater

A Run executes a declared action against exact immutable inputs. Evidence is a structured, reproducible assertion tied to the source, Change Revision, environment, toolchain, dependencies, outputs, and policy version that produced it.

A green check, an agent summary, or a human assertion is not Evidence by itself. Evidence becomes stale when a relevant input changes, and Anyam must explain that invalidation.

AI may summarize source, review work, classify conflicts, propose resolutions, or operate verifiers. It must not silently convert probabilistic judgment into proof, approval, or canonical state.

## 9. Build, release, and deployment remain separate

A Build produces immutable Artifacts from exact inputs. A Release is an approved collection of Artifacts, configuration, and Evidence. Promotion makes that Release current at a Target. Deployment is Promotion to a runtime Target.

Production must receive the same verified Artifacts that were reviewed and approved. Anyam must not rebuild a branch during deployment and imply that the new output is the tested Release. Source may be landed while a Target remains on an earlier Release, and the user interface must make that difference explicit.

The Artifact, Release, and Target model must support projects that produce packages, binaries, documents, models, datasets, infrastructure plans, firmware, or other outputs—not only web applications.

## 10. Project data is not the business model

Anyam must never sell Project Content, use project activity for advertising, or use private Project Content to train models. A hosted service may process Project Content only to provide an explicitly requested capability under documented retention, disclosure, and model-provider policies.

Optional analytics must minimize content, be transparent, and be disableable. A Customer-operated Realm defaults to no Anyam-operated telemetry. Credentials, private model reasoning, and inaccessible Project Content must not enter telemetry or logs.

## 11. Authority-bearing history is attributable and append-only

Every authority-bearing operation must produce an immutable Audit Event identifying the Principal, Actor, Session, Task, affected resources, policy decision, and result. Accepted commits, Change Revisions, Evidence, Releases, policy decisions, and Promotions must not be silently rewritten.

Corrections create new records. Local and Workspace operations should be inspectable and safely undoable where practical through an Operation Log, but undo does not erase accepted history or Audit Events. Auditability records observable actions and provenance; it must not capture credential values or hidden model reasoning.

## 12. Customer-operated means controlled in the customer's Cloudflare account

A customer must be able to operate the complete first-party Anyam product in their own Cloudflare account without a required Anyam SaaS, GitHub, GitLab, another source-control platform, a customer-managed always-on application server, a database cluster, a shared Git filesystem, or a permanent CI runner.

Cloudflare remains a managed infrastructure dependency of this operating mode. Specialized workloads may use optional pull-based runners for operating systems, hardware, networks, or capacity not available in the default execution plane. Anyam must state this dependency honestly rather than implying infrastructure independence through the word "self-hosted."

## 13. Cloudflare-native operation must not trap Project history

Anyam's Project history and public contracts must use documented, versioned, open formats rather than making Cloudflare storage primitives the only intelligible representation. Repository storage, runners, coding agents, verifiers, artifact storage, identity providers, and Targets must sit behind documented interfaces where substitution is meaningful.

A Project Export must include every repository and the complete collaboration and provenance record: Intents, Changes, reviews, policies, Evidence metadata, Artifact indexes, Releases, Audit Events, and schema versions. Large external objects must retain verifiable digests and customer-controlled locations.

The initial product is not required to run an entire Realm outside Cloudflare. It is required to preserve Project portability, adapter boundaries, Git compatibility, and a credible recovery path if a provider changes or disappears.

## Decision test

A proposed feature, optimization, commercial arrangement, or implementation choice is unconstitutional if it requires any of the following:

- hiding necessary first-party capability in a proprietary edition;
- treating a repository, branch, pull request, web application, or coding agent as the whole Project model;
- leaking the existence or metadata of inaccessible source;
- granting a human or agent broad canonical write authority;
- conflating an AI judgment with Evidence;
- rebuilding unverified output during Promotion;
- making ordinary local development depend continuously on the hosted control plane;
- using private Project Content for advertising, sale, or model training;
- erasing authority-bearing history or capturing secrets and private reasoning in audit data;
- preventing a customer from exporting complete Project history in documented formats; or
- making an Anyam-operated SaaS or a third-party forge mandatory for a Customer-operated Realm.

Changes to this constitution require an explicit owner decision recorded with the same visibility and auditability expected of other governing policy changes.
