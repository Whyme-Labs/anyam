# Anyam open-source distribution and licensing

**Research snapshot:** 2 August 2026

**Status:** product recommendation pending formal legal review

**Scope:** Anyam's own software, specifications, documentation, contribution process, trademarks, commercial packaging, and Project Content

This document is product and architecture research, not legal advice. Qualified counsel must approve the final license notices, component boundaries, contributor terms, trademark policy, and hosted-source compliance before Anyam accepts external contributions or ships a public release.

## Decision

Anyam will be a completely open-source product, not open core.

The recommended license architecture is:

| Surface | Recommended license | Reason |
|---|---|---|
| Realm server, web UI, control plane, policy and Landing services, first-party in-process server modules, and Cloudflare deployment implementation | `AGPL-3.0-or-later` | Preserves the right to run, study, modify, and sell the product while requiring operators of modified network-interactive versions to offer their corresponding source to remote users. |
| `anyam` CLI, Git credential helper, local MCP broker, external runner, public SDKs, standalone adapters, protocol libraries, verifier SDK, extension SDK, examples, and templates | `Apache-2.0` | Maximizes adoption and embedding while providing an express patent grant. Security authority remains server-side, so permissive clients cannot bypass Realm policy. |
| Protocol specifications, schemas, interoperability fixtures, export formats, and compatibility test material | `Apache-2.0` | Allows independent compatible implementations, migration tools, mirrors, clients, and competing services without inheriting the server's copyleft. |
| Prose documentation and diagrams | `CC-BY-4.0` | Allows commercial reuse, adaptation, and translation with attribution and change notices. Code samples remain `Apache-2.0`. |
| Word mark, logo, signing identities, and certification marks | Separate trademark and brand policy | Open-source copyright licenses do not grant a general right to imply official status or endorsement. |
| Project source, issues, Changes, Artifacts, Evidence, and other Project Content | Chosen and owned by the Project's users | Anyam's license never changes a hosted Project from open-source, hybrid-source, or closed-source. Service terms receive only the narrow rights needed to operate the requested service. |

The component boundary is intentional. Anyam wants reciprocity for modified hosted implementations and frictionless adoption for the tools and contracts developers and agents must embed. It must not place protocols or exports behind the server's copyleft, and it must not place authoritative security decisions in permissively licensed clients.

## Why `AGPL-3.0-or-later` for the network product

The [GNU Affero General Public License version 3](https://opensource.org/license/agpl-3.0) is OSI approved. Section 13 requires a modified network-interactive version to prominently offer its remote users the corresponding source at no charge. That directly addresses Anyam's main defensibility concern: another operator may sell a hosted Anyam service, but modifications to the covered server remain available to its users.

AGPL does **not**:

- prohibit commercial hosting;
- reserve the Anyam market to one company;
- require Project Content hosted by Anyam to become open source;
- automatically cover independent programs communicating through open protocols; or
- replace the need for architecture, service quality, trust, community, and execution as commercial advantages.

The recommendation uses `AGPL-3.0-or-later`, rather than `AGPL-3.0-only`, because Anyam also recommends distributed contributor copyright and no relicensing CLA. The “or later” grant provides a standards-maintained upgrade path if a later Affero GPL version is published; section 14 explains that recipients may then choose the named or a later version. The tradeoff is that this pre-authorizes a future FSF license text not known today. Counsel must explicitly review this choice. If that delegation is unacceptable, use `AGPL-3.0-only` consistently before accepting outside contributions; changing later may require every copyright holder's permission.

## Why Apache 2.0 at adoption boundaries

The [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0) permits use, modification, redistribution, sublicensing, and commercial derivatives while requiring preservation of license and attribution notices. It includes an express contributor patent grant and patent-litigation termination, and it does not grant trademark rights.

Apache 2.0 is therefore preferable to MIT for Anyam's independent clients and interoperability surfaces. It lets:

- IDEs and coding agents embed an Anyam client;
- proprietary and open-source tools implement Anyam protocols;
- third parties write runners, Verifiers, Targets, repository drivers, and migration tools;
- users export or recover their Projects without an Anyam-operated service; and
- other Realms interoperate without licensing uncertainty at the wire boundary.

The server may import Apache-licensed shared schemas and libraries. The FSF's [license-compatibility guidance](https://www.gnu.org/licenses/license-compatibility.html) identifies Apache 2.0 as compatible with version 3 GNU licenses when combined under the stronger license. Build and dependency checks must still verify every actual third-party license.

The stable separation should be process, HTTP, Git, MCP, command, or WASM-component boundaries wherever practical. An extension that directly links AGPL server internals may fall within different obligations than a standalone adapter using an open protocol; counsel must review the final plugin architecture. Anyam must not promise that a technical label such as “plugin” determines copyright scope.

## Alternatives considered

| Alternative | Finding | Decision |
|---|---|---|
| `Apache-2.0` or MIT for the entire product | Excellent adoption, but permits closed modified hosted forks and proprietary editions. | Reject for the server; use Apache 2.0 at adoption boundaries. |
| `GPL-3.0` | Strong copyleft on conveyed distributions, but ordinary private network use does not trigger the Affero source offer. | Reject for the network server. |
| `MPL-2.0` | Useful file-level copyleft that permits proprietary surrounding files; Mozilla's [MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) positions it between permissive and GNU-family licenses. It has no network-use reciprocity. | Reserve as a future option only for a library where file-level reciprocity is specifically valuable. Do not add it to the initial matrix. |
| `BUSL-1.1` | MariaDB's [Business Source License](https://mariadb.com/bsl11/) is source-available and converts later, but MariaDB explicitly states it is not open source before conversion. | Reject; contradicts the constitution. |
| `SSPL-1.0` | The [Open Source Initiative](https://opensource.org/blog/the-sspl-is-not-an-open-source-license) concluded that SSPL is not an open-source license. | Reject. |
| Custom “no competing SaaS,” noncommercial, or field-of-use terms | The [Open Source Definition](https://opensource.org/osd) prohibits discrimination against fields of endeavor and requires free redistribution. | Reject. |
| Dual AGPL/commercial licensing | Requires centralized relicensing rights or contributor agreements and normally monetizes exceptions that let vendors create closed derivatives. | Reject as the default Anyam model. |
| Proprietary enterprise modules | Withholds first-party capability and creates two products. | Constitutionally prohibited. |

## What “completely open source” means operationally

Every first-party component required to operate a complete Realm must be available in public source form under an OSI-approved license. This includes enterprise-scale identity, governance, compliance, audit, backup, recovery, policy, and administration capabilities when they are built.

The following are not hidden product code:

- customer Project Content and customer secrets;
- Anyam-operated credentials, signing keys, incident records, abuse investigations, and private customer support conversations;
- operational configuration containing sensitive deployment details;
- purchased capacity and human service labor; and
- third-party services or extensions that are not represented as required first-party Anyam capability.

Infrastructure-as-code, migrations, build tooling, installers, and deployment logic needed to operate a complete Customer-operated Realm are part of the open product. Public releases must not depend on a private build step or unpublished first-party service.

## Distribution and packaging

Anyam should use one public development lineage for the complete product, whether implemented as a monorepo or coordinated public repositories. It must not contain a private `enterprise/` tree or publish incomplete source snapshots.

Each release should provide:

- signed source tags and release manifests;
- all exact license texts and third-party notices;
- source links from every hosted AGPL user interface;
- reproducible build instructions and public CI definitions;
- SBOM and provenance for official binaries and deployments;
- public container and package build recipes;
- migration and rollback documentation; and
- a complete Project Export specification independent of Anyam SaaS.

Commercial distribution packages the same code through:

- fully hosted Anyam SaaS;
- managed Customer-operated Realms in the customer's Cloudflare account;
- managed upgrades, backups, disaster recovery, observability, and incident response;
- support, SLAs, security response, compliance assistance, and professional services;
- hosted agent and runner execution capacity;
- verified integrations and compatibility certification; and
- organization-scale administration as a service.

No paid plan may unlock a withheld first-party code path. Plans may differ by consumed capacity, service level, retention operated by Anyam, support response, managed topology, or contractual assurance.

## Protocol, compatibility, and export promises

Anyam's defensibility must not depend on making interoperability legally or technically difficult.

The following must remain public, versioned, and Apache-licensed:

- Change, Revision, Project Revision, Evidence, Artifact, Release, Target, capability, audit, and Project Export schemas;
- REST and MCP contracts;
- repository-driver, runner, Verifier, Target, mirror, and extension contracts;
- canonical event types and compatibility rules;
- public conformance fixtures and negative tests; and
- migration and recovery tooling sufficient to leave an Anyam operator.

Compatibility policy should require semantic versioning for independently shipped packages, documented deprecation windows, machine-readable schema versions, deterministic exports, and conformance tests that independent implementations may run.

The server's AGPL source offer and the Project Export are separate promises:

- the source offer provides the exact corresponding source of the Anyam version serving a remote user; and
- Project Export gives the customer their repositories and collaboration/provenance state in documented formats.

Neither promise may depend on an active commercial subscription.

## Contributions and governance

Use the unmodified [Developer Certificate of Origin 1.1](https://developercertificate.org/) with an actual `Signed-off-by:` trailer on every contributed commit. The contributor certifies that they created the contribution or have the right to submit it under the indicated open-source license, and accepts that the public contribution record is retained.

Anyam should not require a CLA or copyright assignment by default:

- contributors retain their copyright;
- inbound licensing equals the license already declared for the affected files;
- no company receives a unilateral right to turn community contributions into a proprietary edition; and
- incompatible relicensing requires the necessary contributor consent or replacement of affected contributions.

This constraint is deliberately protective. A future patent or foundation structure may justify a narrowly scoped contributor agreement, but that would require a public governance decision, legal review, and a demonstration that it cannot enable an open-core conversion.

AI-assisted contributions are allowed because agents are part of Anyam's thesis. The submitting human or organization remains responsible for:

- reviewing and validating the work;
- having the right to submit it;
- complying with model and tool terms;
- detecting and attributing third-party material;
- disclosing material agent assistance in the contribution record; and
- not treating generated explanation or hidden reasoning as Evidence.

The contribution process should publish `GOVERNANCE.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, the DCO, maintainer/reviewer/release/security roles, and a public design-decision process. License changes, public protocol changes, security-boundary changes, and material domain-model changes require a public proposal and compatibility analysis.

## License hygiene

Adopt [REUSE Specification 3.3](https://reuse.software/spec-3.3/) and SPDX identifiers from the first implementation commit:

- exact texts in `LICENSES/AGPL-3.0-or-later.txt`, `LICENSES/Apache-2.0.txt`, and `LICENSES/CC-BY-4.0.txt`;
- `SPDX-License-Identifier` and `SPDX-FileCopyrightText` in authored files where practical;
- `REUSE.toml` for generated files, vendored trees, binary assets, or directory-wide annotations;
- `reuse lint` as a required check;
- machine-readable third-party notices and dependency license scanning; and
- an explicit SPDX expression for every separately licensed package.

The repository root should also include a human-readable `LICENSE.md` explaining the matrix. A single root license file must not falsely imply that every file has the same license.

## Trademarks and official identity

Copyright openness and official identity are separate. Apache 2.0 explicitly withholds general trademark permission, and AGPL permits reasonable additional terms that prevent misrepresentation and decline trademark grants.

Before public launch, publish a transparent trademark policy that:

- permits truthful nominative uses such as “works with Anyam,” “for Anyam,” and “based on Anyam”;
- permits unmodified official distributions to identify their exact official version;
- lets modified distributions describe their origin while requiring clear modified/unofficial labeling;
- prevents confusing product, company, domain, social-handle, logo, signing-key, certification, or endorsement claims; and
- defines the owner and succession plan for the marks, domains, release keys, and official package namespaces.

The policy must not be used as a disguised restriction on running or forking the software. The separate identity-clearance gate for the working Anyam name remains in force.

## Project Content and third-party extensions

Anyam hosts open-source, hybrid-source, and closed-source Projects. A Project owner selects the license and disclosure policy of each Source Space. Anyam must preserve those declarations through Project Views, Publication Changes, mirrors, and exports; it does not acquire ownership or relicense the Project.

First-party extensions required for full functionality remain open source under the applicable Anyam license. Independent third-party extensions may choose their own lawful terms when they use a documented external boundary. Any official catalog must disclose the extension's license, source availability, data access, requested capabilities, model access, security review status, and commercial terms. Closed third-party extensions must never become an undeclared dependency of the complete open product.

## Release gates

Before Anyam accepts external contributions or publishes its first software release, complete all of the following:

1. Qualified counsel approves `AGPL-3.0-or-later` versus `AGPL-3.0-only`, the mixed-license boundaries, notices, and source-offer implementation.
2. Counsel reviews the process/SDK/plugin boundaries and every planned third-party dependency for license compatibility.
3. The legal owner or steward of copyright, trademarks, domains, signing keys, and package namespaces is documented.
4. The DCO, agent-contribution disclosure, governance, trademark, privacy, and hosted-service terms are reviewed together.
5. Every hosted UI and API exposes the exact corresponding-source link for its deployed version.
6. REUSE linting, SBOM generation, dependency policy, third-party notices, and release-source verification pass in CI.
7. Project Content ownership, service-operation rights, export, deletion, and telemetry terms match the constitution.
8. A clean-room install of a Customer-operated Realm succeeds using only public source, public build instructions, and the customer's Cloudflare account.

## Final assessment

The recommended structure is deliberately asymmetric:

> **Reciprocal where Anyam is operated as a network product; permissive where people and tools must interoperate with it.**

It supports hosted SaaS and managed Cloudflare deployments without creating a proprietary edition. It protects community trust through distributed copyright, DCO sign-off, open governance, and exact source availability. It protects adoption through permissive clients, SDKs, protocols, examples, and exports. It protects sustainable revenue through operation and assurance rather than artificial product incompleteness.

Anyam's defensibility remains the coherent Source Space, Change, capability, Evidence, and release system—and the trust earned by operating it well—not a license that prevents competition.
