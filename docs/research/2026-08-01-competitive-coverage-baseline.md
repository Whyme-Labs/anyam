# Anyam competitive coverage baseline

**Research date:** 1 August 2026

**Decision scope:** What the strongest currently documented configurations of the named products provide, and which Anyam capabilities are baseline parity, proven patterns to borrow, integrations, deliberate exclusions, or defensible differentiation.

**Evidence policy:** Primary sources only: official product documentation, pricing/feature pages, project documentation, specifications, and official repositories. “Not documented” means that no first-class equivalent was found in the reviewed official material; it is not proof that no private extension or expert workaround exists.

## Executive decision

Anyam should not enter the market as a more modern forge or as an AI coding agent. Those propositions are already crowded.

- GitHub and GitLab set the hosted enterprise, policy, security, CI, workspace, and agent-platform benchmarks.
- Gitea, Forgejo, Codeberg, SourceHut, OneDev, Radicle, and Fossil establish high expectations for self-ownership, portability, open implementations, and focused workflows.
- OneDev now provides the strongest compact “AI teammate inside a self-hosted forge” benchmark: AI users implement assigned issues, open and revise pull requests, review work, repair CI failures and conflicts, while browser workspaces, a CLI, and portable skills connect external coding agents.
- Gerrit, Jujutsu, Sapling, GitButler, and Graphite prove that stable change identity, patch-set review, automatic snapshots, operation-level undo, parallel work, and stacked changes are usable patterns. None is sufficient as Anyam's moat.
- Perforce proves that granular source access and large-asset locking are possible, but through a centralized depot model that is poorly suited to public Git collaboration.
- Bitbucket now documents agentic Pipelines using Rovo Dev, Codex, or Claude Code. GitHub supports first- and third-party asynchronous coding agents, and GitLab's Duo Agent Platform is GA. “Connect a coding agent to an issue and receive a pull request” is parity.

The defensible product remains the combination:

```text
independently protected Source Spaces
+ capability-composed Project Views
+ atomic Project Revisions across spaces
+ one stable Change spanning public and private source
+ governed Publication Changes
+ Sealed Verifiers with disclosure-controlled evidence
+ principal-to-agent task capabilities and Context Manifests
+ evidence-bound Releases promoted to general Targets
```

No reviewed product documents that complete model. That is a bounded inference from the official sources reviewed, not a universal novelty claim.

## Coverage legend

| Symbol | Meaning |
|---|---|
| **●** | Strong, first-class documented support in the strongest relevant configuration |
| **◐** | Partial, add-on, tier-gated, preview/experimental, or a narrower analogue |
| **○** | No first-class equivalent found in reviewed official documentation |
| **—** | Not applicable to the product's intended layer |

Maturity labels are feature-specific. A GA product may contain preview or experimental features.

## Product classes

| Class | Products | What Anyam should learn |
|---|---|---|
| Full hosted development platforms | GitHub, GitLab, Azure DevOps, Bitbucket | Table-stakes collaboration, policy, CI, security, scale, ecosystem, enterprise administration |
| Self-owned forges | Gitea, Forgejo, OneDev | Low-friction installation, mirrors, packages, local runners, portability, integrated workflow |
| Public-interest and minimalist forges | Codeberg, SourceHut | Governance, trust, public preservation, no tracking, email workflows, operational clarity |
| Change/VCS specialists | Gerrit, Jujutsu, Sapling, GitButler, Graphite | Stable changes, patch sets, stacks, snapshots, conflict preservation, undo, stack-aware landing |
| Granular/large-asset SCM | Perforce P4 | File ACLs, exclusive locking, large monorepo and binary workflows |
| Sovereign integrated alternatives | Radicle, Fossil | Signed local-first collaboration objects, peer-to-peer replication, self-contained project state |

## Full-platform coverage

This table scores native semantics, not whether a skilled team could assemble a workaround with multiple repositories and scripts.

| Capability | GitHub | GitLab | Gitea | Forgejo / Codeberg | OneDev | Azure DevOps | Bitbucket | SourceHut |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Git hosting, branches, tags, review | ● | ● | ● | ● | ● | ● | ● | ● |
| Issues/work planning | ● | ● | ● | ● | ● | ● | ◐ | ● |
| Enforced review and branch policy | ● | ● | ◐ | ◐ | ● | ● | ● | ◐ |
| Merge queue/train or equivalent | ● | ● | ◐ | ◐ | ○ | ◐ | ◐ | ○ |
| Built-in CI/CD | ● | ● | ● | ● | ● | ● | ● | ● |
| Managed and self-hosted runners | ● | ● | ◐ | ◐ | ● | ● | ● | ◐ |
| Browser/remote development workspace | ● | ● | ○ | ○ | ● | ◐ | ○ | ○ |
| Artifact/package/release services | ● | ● | ● | ● | ● | ● | ◐ | ◐ |
| Enterprise SSO, audit, lifecycle governance | ● | ● | ◐ | ◐ | ◐ | ● | ● | ○ |
| Integrated security scanning/governance | ● | ● | ◐ | ◐ | ◐ | ● | ● | ○ |
| Autonomous issue-to-change agent | ● | ● | ○ | ○ | ● | ◐ | ◐ | ○ |
| Third-party/model-choice agent integration | ● | ● | ○ | ○ | ● | ◐ | ◐ | ○ |
| Open-source server | ○ | ◐ | ● | ● | ● | ○ | ○ | ● |
| Customer-operated deployment | ◐ | ● | ● | ● | ● | ● | ● | ● |
| Repository/project visibility boundary | ● | ● | ● | ● | ● | ● | ● | ● |
| Independently permissioned collaboration surfaces | ◐ | ● | ● | ● | ● | ● | ◐ | ◐ |
| Public/private source inside one coherent versioned project | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Atomic project state across different source trust boundaries | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |
| Governed selective publication and sealed verification | ○ | ○ | ○ | ○ | ○ | ○ | ○ | ○ |

### GitHub

GitHub remains the broadest adoption and ecosystem benchmark. Its strongest configuration combines repositories, pull requests, Projects, Discussions, Actions, packages, releases, Codespaces, Apps, custom roles, enterprise audit/identity controls, rulesets, merge queues, deployment environments, and security products. Current rulesets can require reviews, teams for path patterns, deployments, signed commits, status checks, code scanning, code quality, coverage, workflows, and a merge queue; enterprise push rulesets can constrain an entire private/internal fork network ([ruleset reference](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)). Codespaces issues repository-scoped tokens and can request separately enumerated access to other repositories ([Codespaces repository access](https://docs.github.com/en/codespaces/managing-your-codespaces/managing-repository-access-for-your-codespaces)).

GitHub's agent surface is now much larger than the old baseline. Copilot includes cloud agents, custom agents, skills, hooks, plugins, agentic workflows, code review, and enterprise controls. Codex and Claude can be assigned work and create pull requests, but the third-party-agent integrations are **public preview**, consume Actions minutes and AI credits, and operate through GitHub Apps ([third-party agents](https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents), [agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)). This is strong workflow parity, but it remains repository/branch/pull-request centric.

Source visibility remains at repository/fork-network granularity. Internal visibility is an enterprise membership boundary, not a selectively disclosed source graph. Path rules restrict writes; they do not create safe public trees that omit private object reachability. GitHub Packages can have access separate from a repository, which is a useful artifact-access precedent, not a source-space equivalent.

Current list pricing is $4/user/month for Team and starts at $21/user/month for Enterprise; Advanced Security and Copilot are additional products. Copilot Business is $19/user/month and Enterprise $39/user/month with usage credits ([GitHub pricing](https://github.com/pricing), [Copilot organization billing](https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises)). Prices and promotional allowances are refresh-sensitive.

### GitLab

GitLab remains the breadth benchmark for an integrated DevSecOps platform. A GitLab project combines a Git repository, work items, merge requests, CI/CD, registries, environments, security results, and operational features, with public/private visibility and internal visibility on Self-Managed and Dedicated ([project model](https://docs.gitlab.com/user/project/organize_work_with_projects/), [visibility](https://docs.gitlab.com/user/public_access/)). Merge trains validate each merge request with the changes ahead of it, remote workspaces provide reproducible development environments, and Ultimate adds broad application-security, compliance, portfolio, and governance features. GitLab also supports confidential issues in public projects, but merge requests are not independently confidential in the same direct way ([confidential issues](https://docs.gitlab.com/user/project/issues/confidential_issues/)).

The Duo Agent Platform reached GA in GitLab 18.8 for Premium and Ultimate, including self-managed deployments ([GA announcement](https://about.gitlab.com/press/releases/2026-01-15-gitlab-announces-duo-agent-platform-general-availability/)). However, maturity is not uniform: the current Flows REST API is explicitly **Experiment**, even though the platform is GA, and its privilege list is coarse (`read_write_files`, `read_write_gitlab`, `run_commands`, `use_git`, and MCP access) relative to Anyam's intended task/source/effect grants ([Flows API](https://docs.gitlab.com/api/duo_agent_platform_flows/)). Premium now documents external agents including Codex and Claude and usage through GitLab Credits ([Premium features](https://about.gitlab.com/pricing/premium/)).

GitLab provides the strongest integrated security and compliance breadth reviewed, but its source model remains project/repository/branch/merge-request based. Confidential work items, subgroup access, protected branches and environments are useful precedents; they do not create one atomic revision across public and private source lineages. Premium is currently listed at $29/user/month billed annually; Ultimate is quote-based ([pricing](https://about.gitlab.com/pricing/)).

### Gitea

Gitea's open-source edition provides Git hosting, issues, pull requests, project management, Actions, packages, releases, wikis, authentication options, APIs, and push/pull mirroring. Its repository-unit permission model is a valuable precedent for permissioning code, issues, pull requests, releases, wiki, packages, and Actions separately. Its package registry covers a broad set of ecosystems, though current package access remains owner/organization based and the docs say finer team permission is future work ([package registry](https://docs.gitea.com/usage/packages/overview), [permissions](https://docs.gitea.com/1.26/usage/access-control/permissions), [mirrors](https://docs.gitea.com/usage/repository/repo-mirror)).

Gitea Actions is intentionally compatible with GitHub Actions where possible, can retrieve actions from arbitrary Git repositories, and can operate with private/intranet mirrors, but the official docs enumerate semantic differences and warn that runner permissions remain an area for refinement ([Actions](https://docs.gitea.com/usage/actions), [Actions FAQ](https://docs.gitea.com/usage/actions/faq), [offline design](https://docs.gitea.com/usage/actions/design)). It is not safe to promise complete Actions compatibility from this precedent.

Gitea is no longer only “free lightweight self-hosting.” The MIT-licensed self-hosted edition is free, while Gitea Enterprise currently advertises SAML, audit logs, dependency scanning, IP allowlists, inherited branch protection, autoscaling runners, and support at a list rate of $19/user/month with a displayed annual-commitment promotion ([pricing](https://about.gitea.com/pricing/), [enterprise features](https://about.gitea.com/products/gitea-enterprise/)). Gitea Cloud offers isolated managed instances. These make sovereignty and operational simplicity parity requirements, not a niche extra.

### Forgejo and Codeberg

Forgejo v16 is a complete free-software forge with Git hosting, issues, pull requests, projects, branch/tag protection, releases, mirrors, search, wikis, packages, APIs, OAuth, and Actions ([current documentation index](https://forgejo.org/docs/latest/)). Its package coverage is very broad ([package registry](https://forgejo.org/docs/latest/user/packages/)). Forgejo Actions is familiar to GitHub users, reads `.forgejo/workflows` and optionally `.github/workflows`, and supports separate runners, but the current official guide states that it is **not designed to be compatible with GitHub Actions** and that migrations normally need adjustments ([Actions overview](https://forgejo.org/docs/latest/user/actions/overview/)). That corrects the earlier tendency to group Gitea and Forgejo as one Actions-compatibility score.

Codeberg adds nonprofit, community-driven governance and operates mostly on its own infrastructure using free software. It supports public and limited private repositories, Pages, translations, Woodpecker CI, and Forgejo Actions. However, Codeberg explicitly recommends self-hosted Forgejo for commercial private hosting. Hosted Woodpecker onboarding is manual and offered as-is; hosted Forgejo Actions remains limited/open alpha, while self-hosted runners are supported ([Codeberg FAQ](https://docs.codeberg.org/getting-started/faq/), [CI](https://docs.codeberg.org/ci/), [repository permissions](https://docs.codeberg.org/collaborating/repo-permissions/)). Codeberg has also disabled pull mirrors because of resource abuse; manual push mirroring remains possible, so it should not inherit Forgejo's full mirror score. Codeberg is therefore a governance and public-interest benchmark, not an enterprise private-SaaS feature benchmark.

Forgejo's federation work should remain an expansion watch item, not an MVP dependency. The reviewed current stable feature index does not establish mature cross-instance moderation, access control, and atomic collaboration sufficient for Anyam's trust model.

### OneDev

OneDev is the closest compact product competitor. Community Edition currently includes Git hosting, pull requests, configurable issues, service desk, CI/CD, packages, per-commit regex/symbol search, code intelligence, browser workspaces, OIDC/2FA, autonomous AI users, and the TOD CLI plus skills. Enterprise adds scalable workspace provisioners and organizational features at $6/user/month ([pricing](https://onedev.io/pricing), [workspaces](https://docs.onedev.io/tutorials/workspace/working-with-workspaces)). It can run CI jobs locally against uncommitted changes, a particularly strong developer-loop benchmark.

AI users can implement assigned issues, open pull requests, respond to review findings, review other changes, and attempt CI-failure and merge-conflict repair. Workspaces can run OpenCode, Claude Code, or Codex; the issue remains the specification and the branch/PR remains the change mechanism ([AI issue workflow](https://docs.onedev.io/tutorials/ai/working-with-ai-user/collab-with-ai-user/assign-issues), [AI teammates overview](https://onedev.io/blogs/ai-teammates)). This invalidates any positioning based simply on “AI users inside a self-hosted forge,” “browser workspaces for agents,” or “CLI plus agent skills.”

OneDev still uses project/repository roles, issue branches, pull requests, and ordinary source visibility. It does not currently ship a merge queue. The reviewed docs do not establish Source Spaces, safe composed views, atomic cross-visibility revisions, model-provider source policies, Context Manifests, sealed result-only tools, or landing-service-only canonical mutation.

### Azure DevOps

Azure DevOps remains a strong enterprise-suite benchmark: Azure Boards, Repos, Pipelines, Artifacts, Test Plans, dashboards, wikis, extensions, Entra integration, and Azure DevOps Server. Azure Repos supports Git and TFVC, granular repository/branch permissions, path-triggered reviewers, build/status policies, linked work items, comment resolution, and merge-type restrictions ([branch policies](https://learn.microsoft.com/en-us/azure/devops/repos/git/branch-policies-overview?view=azure-devops), [Repos index](https://learn.microsoft.com/en-us/azure/devops/repos/?view=azure-devops)). Its work-item traceability and formal testing remain stronger than many code-first forges.

Microsoft now lists GitHub Copilot Code Review for Azure Repos and separately sells GitHub Advanced Security for Azure DevOps. A local Azure DevOps MCP server is GA and a hosted remote MCP service is public preview, but this remains a narrower agent story than an integrated autonomous project actor. New public projects have been retired and existing public projects are scheduled to become private in 2027, making Azure DevOps an enterprise/private suite rather than a future public-forge benchmark ([public-project retirement](https://learn.microsoft.com/en-us/azure/devops/organizations/projects/make-project-public?view=azure-devops), [remote MCP](https://learn.microsoft.com/en-us/azure/devops/mcp-server/remote-mcp-server?view=azure-devops)). The Basic plan is free for five users then $6/user/month, includes unlimited private Git repositories, Boards and the base Pipelines/Artifacts allocation; Test Plans is $52/user/month. One Microsoft-hosted job with 1,800 minutes and one self-hosted parallel job are included ([Azure DevOps pricing](https://azure.microsoft.com/en-us/pricing/details/devops/azure-devops-services/)).

Azure DevOps is a mature proprietary suite, not an open-source or Cloudflare-account-owned control plane, and its source authority remains repository/branch based.

### Bitbucket

Bitbucket Cloud combines Git repositories and pull requests with Jira/Confluence integration, Pipelines, deployments, package and marketplace integrations, hosted/self-hosted runners, branch permissions, merge checks, and Atlassian Guard administration. Required merge checks are Premium; checks can require builds, approvals, default reviewers, resolved tasks, and freshness relative to the destination branch ([merge checks](https://support.atlassian.com/bitbucket-cloud/docs/suggest-or-require-checks-before-a-merge/)). Workspace access tokens are scoped and expiring but remain persistent bearer secrets rather than task delegation ([workspace tokens](https://support.atlassian.com/bitbucket-cloud/docs/workspace-access-tokens/)).

The important correction is **beta** Agentic Pipelines. Bitbucket now documents pipeline agents using Atlassian-managed Rovo Dev or bring-your-own Codex or Claude Code, plus an MCP interface to Bitbucket ([Agentic Pipelines](https://support.atlassian.com/bitbucket-cloud/docs/agentic-pipelines/)). The current security model includes explicit scopes and step-bound short-lived OAuth credentials, though provider/bootstrap configuration still needs separately managed credentials. This is genuine agent integration and a useful least-lifetime precedent, while also demonstrating why Anyam's principal/actor/task grant and secret-broker model must extend beyond one pipeline step ([agentic security](https://support.atlassian.com/bitbucket-cloud/docs/authentication-and-security-for-agentic-pipelines/)).

Bitbucket remains repository/branch/PR centric, Atlassian-account centric, and proprietary. Current Cloud list pricing is $3.65/user/month for Standard and $7.25/user/month for Premium after the five-user Free tier. Bitbucket Data Center offers customer-operated deployment, but is proprietary and scheduled to reach end of life on 28 March 2029 ([pricing](https://www.atlassian.com/software/bitbucket/pricing), [Data Center lifecycle](https://www.atlassian.com/enterprise/data-center)).

### SourceHut

SourceHut is intentionally different: Git and Mercurial hosting, mailing lists, ticket tracking, build manifests, project hubs, Pages, and an email/patch-oriented workflow. It is 100% open source, self-hostable, has no ads or tracking, works without JavaScript, and explicitly promises no AI features. Its hosted service remains labeled public alpha. All paid tiers receive the same features at $4/$8/$12 per month, with financial assistance available ([official pricing and principles](https://sourcehut.org/pricing/)). Self-hosting is supported but is a multi-service Alpine/PostgreSQL/Redis-compatible/mail deployment, not a single lightweight forge binary ([installation](https://man.sr.ht/installation.md)).

SourceHut is the benchmark for minimalism, email participation, portability, transparent economics, and refusing data monetization—not for GitHub-style review, enterprise governance, or agent orchestration. Anyam should support email notifications and portable patch contribution later, but should not copy SourceHut's deliberately different interaction model wholesale.

## Version-control and specialist coverage

| Capability | Gerrit | Jujutsu | Sapling | GitButler | Graphite | Perforce P4 | Radicle | Fossil |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Stable logical Change identity | ● | ● | ◐ | ◐ | ◐ | ◐ | ◐ | ◐ |
| Immutable revisions/patch sets under a Change | ● | ● | ◐ | ◐ | ◐ | ● | ● | ● |
| Automatic working-copy snapshots | ○ | ● | ◐ | ● | ○ | ○ | ○ | ◐ |
| Operation log / reliable undo | ○ | ● | ● | ● | ○ | ◐ | ○ | ● |
| First-class stacks/dependencies | ◐ | ● | ● | ● | ● | ● | ◐ | ◐ |
| Conflicts preserved as versioned state | ◐ | ● | ○ | ● | ○ | ● | ○ | ◐ |
| Integrated code-review collaboration | ● | ○ | ○ | ◐ | ● | ● | ● | ● |
| Independent file/path read ACL | ◐ | ○ | ○ | ○ | ○ | ● | ○ | ○ |
| Public Git interoperability | ● | ● | ● | ● | ● | ◐ | ● | ○ |
| Complete forge/delivery platform | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ◐ | ◐ |
| Open-source core | ● | ● | ● | ● | ◐ | ○ | ● | ● |
| Safe composed public/private project graph | ○ | ○ | ○ | ○ | ○ | ◐ | ○ | ○ |

### Gerrit

Gerrit proves the stable review identity model. A `Change-Id` groups uploaded commit versions as patch sets, preserving comments and approvals while content changes; submit requirements and project inheritance provide policy, and related changes/topics express dependencies. Gerrit's topics are not proof of cross-repository atomicity: with `submitWholeTopic`, same-repository changes can be guaranteed together, but the official docs warn that a cross-repository submit can partially succeed. Gerrit is Git-compatible, open source, and can submit related changes, but it is a review server rather than a full modern planning, workspace, artifact, release, and target platform. Its ceremony is optimized for disciplined team review rather than the simplest solo workflow. Anyam should borrow stable Change IDs, immutable Change Revisions, revision-to-revision review, expected-state submission, and explicit dependencies—not Gerrit's user experience wholesale.

Official references: [Change-Id](https://gerrit-review.googlesource.com/Documentation/user-changeid.html), [changes and patch sets](https://gerrit-review.googlesource.com/Documentation/concept-changes.html), [submit requirements](https://gerrit-review.googlesource.com/Documentation/config-submit-requirements.html), [cross-repository changes](https://gerrit-review.googlesource.com/Documentation/cross-repository-changes.html).

### Jujutsu

Jujutsu is the clearest proof for Anyam's local change semantics. It separates stable change IDs from commit IDs, automatically snapshots the working copy, records repository operations in an operation log, makes rewriting and undo safe, models conflicts in commits, and supports colocated Git repositories. It remains a young, pre-1.0/experimental VCS even though its Git backend is described as production-ready; higher-level Jujutsu metadata is not all represented in Git. It is a VCS/CLI rather than a hosted collaboration and delivery platform. Its Git backend also means it inherits Git repository visibility unless another control plane composes several repositories.

Official references: [project and maturity](https://github.com/jj-vcs/jj), [working copy](https://docs.jj-vcs.dev/latest/working-copy/), [operation log](https://docs.jj-vcs.dev/latest/operation-log/), [conflicts](https://docs.jj-vcs.dev/latest/conflicts/), [Git compatibility](https://docs.jj-vcs.dev/latest/git-compatibility/). Current undo commands are `jj undo`, `jj redo`, `jj op revert`, and `jj op restore`; older references to `jj op undo` are stale.

### Sapling

Sapling proves that large-repository clients can make stacks, smart history views, amend/rebase workflows, undo, and Git interoperability approachable. Its mutation model is a predecessor/successor relation rather than a forge-wide stable Change ID, its conflicts use conventional interrupted-operation resolution, and undo does not cover every working-copy or remote effect. The public Git modes document LFS, submodule, tag, and interoperability caveats; Meta's full Mononoke/EdenFS server stack is not delivered as a generally usable public forge. Anyam should borrow the stack graph, smart log, and reversible-operation ergonomics while retaining standard Git access and a simpler project model.

Official references: [Sapling documentation](https://sapling-scm.com/docs/category/introduction/), [stacks](https://sapling-scm.com/docs/overview/stacks), [undo](https://sapling-scm.com/docs/commands/undo/), [Smartlog](https://sapling-scm.com/docs/overview/smartlog/), [Git support modes](https://sapling-scm.com/docs/git/git_support_modes/).

### GitButler

GitButler demonstrates parallel virtual branches in one working directory, stacked branches, selective hunk ownership, snapshots, conflicted commits, and undo-oriented local UX. It is no longer accurately described as only a GitHub companion: its `but` CLI, agent setup/skills, arbitrary Git remotes, GitHub, and GitLab/self-hosted GitLab integrations make it a serious local agent-workflow benchmark. The skill grants no new authority and uses existing repository credentials and protections. GitButler still does not host repositories, organization authorization, CI, evidence or releases. The pattern to borrow is a unified local workspace that can present multiple logical Changes without forcing users to juggle worktrees manually.

Official references: [GitButler overview](https://docs.gitbutler.com/overview), [virtual branches](https://docs.gitbutler.com/features/branch-management/virtual-branches), [timeline](https://docs.gitbutler.com/features/timeline), [CLI](https://docs.gitbutler.com/cli-overview), [agent integration](https://docs.gitbutler.com/ai-agents/getting-started), [GitLab integration](https://docs.gitbutler.com/features/forge-integration/gitlab-integration).

### Graphite

Graphite is a strong stacked-pull-request and stack-aware merge benchmark layered on GitHub. GitHub is currently its only Git provider, with GHES restricted to enterprise integration. It provides a CLI, stack navigation/review, restacking, and merge-queue automation; stack merges land pull requests sequentially and retry/restack rather than form one atomic source transaction. The current batching capability is private beta, so it must not be scored as general availability. Graphite is proprietary SaaS, not a sovereignty baseline. Anyam should borrow stack review and cohort visualization while owning integration semantics natively.

Official references: [GitHub authentication](https://graphite.com/docs/authenticate-with-github-app), [stacked changes](https://graphite.com/docs/intro-to-graphite), [merge behavior](https://graphite.com/docs/merge-pull-requests), [merge queue](https://graphite.com/docs/get-started-merge-queue), [batching](https://graphite.com/docs/merge-queue-optimizations).

### Perforce P4

Perforce P4 provides the strongest reviewed precedent for granular source permissions, exclusive file locking, streams, changelists, shelving, and large binary/monorepo workflows. Protections can include or exclude depot paths, and file types can require exclusive open. This is a genuine partial analogue to Source Spaces, but its centralized depot model does not create separately exportable, safe public Git histories or one public/private projection protocol. Anyam should borrow explicit source-boundary policy, locking for non-mergeable assets, and large-object ergonomics—not arbitrary hidden files inside one Git graph.

Official references: [protections](https://help.perforce.com/helix-core/server-apps/p4sag/current/Content/P4SAG/protections.html), [file locking](https://help.perforce.com/helix-core/server-apps/cmdref/current/Content/CmdRef/file.types.synopsis.html), [streams](https://help.perforce.com/helix-core/server-apps/p4guide/current/Content/P4Guide/streams.html).

### Radicle

Radicle is a sovereign, local-first Git collaboration network. It uses cryptographic identities, signed repository state, peer-to-peer replication, and collaborative objects for issues and patches. It now supports private repositories through DID allowlists, encrypted transport, selective replication, and hidden private repository metadata, plus an official CI broker that invokes external adapters. Important caveats remain: private data is not encrypted at rest, removing a peer cannot retract prior copies, public-to-private conversion cannot erase replicated data, and the current user guide states that the codebase has not undergone a formal security audit. The CI broker is event/adaptor orchestration, not a complete hosted execution, artifact and promotion suite. Radicle proves that collaboration metadata need not be owned by one SaaS and that signed state can travel with a project. Anyam should borrow open event/object formats, signed provenance, exportability, and later federation concepts while keeping a highly available Realm and policy authority.

Official references: [protocol guide](https://radicle.xyz/guides/protocol/), [private repositories and security caveats](https://radicle.xyz/guides/user/), [CI broker](https://radicle.dev/2025/07/23/using-radicle-ci-for-development), [Radicle repository](https://github.com/radicle-dev/heartwood).

### Fossil

Fossil packages version control, tickets, wiki, forum, technotes, chat, and web UI into one self-contained SQLite repository with built-in synchronization and an operation-oriented administrative story. Private branches are omitted from normal synchronization and can be transferred with private capability, but all private branches are treated together: they cannot be selectively cloned, pushed, pulled or scrubbed. They are not a general public/private source-composition model. Fossil is durable, portable, and easy to self-host, but it is not Git-compatible and has a much smaller ecosystem. It is a precedent for complete project export and locally owned collaboration history, not for Anyam's wire protocol or public contribution surface.

Official references: [Fossil home](https://fossil-scm.org/home/doc/trunk/www/index.wiki), [technical overview](https://fossil-scm.org/home/doc/trunk/www/tech_overview.wiki), [private branches](https://www.fossil-scm.org/home/doc/trunk/www/private.wiki), [self-hosting](https://fossil-scm.org/home/doc/trunk/www/selfhost.wiki).

## Public/private source granularity

The central market gap is narrower and more specific than “better permissions.”

| Existing pattern | What it provides | Why it is not Anyam's model |
|---|---|---|
| Public/private/internal repository visibility | A hard boundary around one repository | One repository still maps to one source graph and visibility boundary |
| Groups, subgroups and repository roles | Hierarchical access to several repositories | Users must coordinate separate histories, changes, releases, and credentials |
| Sparse checkout / partial clone | Less local materialization or transfer | Reachable object graph and authority do not become safely public |
| Submodules/subtrees | Separate source histories | Cross-repository review, atomicity and developer ergonomics remain exposed |
| Monorepo path rules | Write restrictions and reviewer routing | They do not prevent read/discovery of private objects |
| Perforce depot protections | File/path read and write ACLs | Centralized depot; no safe standard-Git public lineage or composed Git view |
| Confidential issues or private CI | Restricted collaboration or logs | Source history and release lineage remain separate and manually correlated |
| Filtered public mirror | A publishable Git repository | History rewriting, leakage review and synchronization are external scripts |

Anyam's rule should remain:

> A Project View never contains references to inaccessible Source Space objects. Public source is a real independent lineage, not an authorization error over a reachable private graph.

The corresponding requirement is atomic project-level state: a Project Revision identifies exact snapshots in all participating Source Spaces, while each actor receives only a safe projection. A Change may update multiple spaces but exposes disclosure-specific summaries, diffs, evidence and findings.

## AI-agent comparison

| Capability | Current market status | Anyam decision |
|---|---|---|
| Assign issue/task to coding agent | Strong in GitHub, GitLab, OneDev; now present in Bitbucket automation | Baseline parity |
| Agent creates branch and pull request | Strong/common | Baseline compatibility view, not native model |
| Agent responds to review and CI | Strong in GitHub/OneDev; increasingly broad elsewhere | Baseline parity |
| Agent skills, hooks, MCP and custom agents | Strong and rapidly changing | Support open adapters; never make one model/vendor canonical |
| Isolated remote workspace | GitHub/GitLab/OneDev strong | Baseline parity plus local-first option |
| Agent identity distinct from delegating principal | Apps/bots/audit provide partial analogues | Native principal → actor → session → task chain |
| Narrow task/source/effect capability | Mostly repository/client/flow privileges | Core differentiator |
| Exact revision-addressed Context Manifest | Context graphs/indexes exist, but reproducible supplied context is not a common contract | Core differentiator |
| Source-space-specific model policy | Enterprise model controls exist, but not per-source composed views | Core differentiator |
| Result-only access to restricted verifier | Achievable through CI scripts | First-class differentiator |
| Evidence-bound output and protected canonical landing | Status checks and protected branches are partial | Core invariant |

Agent instructions, skills and hooks are guidance; they are not authorization. Anyam must enforce access, network, secrets, canonical writes, approvals, and promotion on the server. Git moves source objects; MCP/REST coordinates semantic work; the CLI/local broker keeps long-lived credentials outside model context.

## What Anyam must build for parity

Developers will not tolerate novel source semantics inside a forge missing ordinary development capabilities. The credible public-beta floor is:

- Git HTTPS and SSH, branches/tags, import/export, mirrors, LFS or an equivalent large-object path.
- Fast source browse, blame, history, textual diff, search, symbols, definitions and references.
- Intents/issues, labels, milestones, comments, notifications and accessible public contribution.
- Pull-request-like Change review, inline comments, suggestions, reviewer ownership, revision comparison and change dependencies.
- Rules, approvals, protected canonical state, integration queue/cohorts, explainable policy failures and audit.
- Declarative actions, logs, caches, artifacts, managed Linux execution and external pull runners.
- Remote workspaces and a fast local/offline loop.
- Generic and OCI artifacts first, plus registry adapters.
- Releases, protected Targets, promotion, health verification and rollback evidence.
- OIDC/OAuth, short-lived credentials, organization/team/project roles, app installations, webhooks, REST, CLI and MCP.
- Secret scanning, dependency/security result ingestion, SBOM and provenance integration.
- Complete Git and collaboration-metadata export.

“Parity” does not mean cloning every UI or marketplace. It means that the novel workflow never requires users to surrender capabilities they reasonably expect from GitHub Team, GitLab Premium, Gitea/Forgejo, or OneDev.

## Proven patterns Anyam should borrow

| Source | Proven pattern | Anyam adaptation |
|---|---|---|
| Gerrit | Stable Change-Id, patch sets, submit requirements | Stable Change with immutable Change Revisions and explicit policy |
| Jujutsu | Change IDs, auto snapshot, operation log, conflict state | Local-first snapshots, undo and durable typed conflicts |
| Sapling | Smartlog, stacks, large-repo ergonomics | Unified stack graph and safe restacking |
| GitButler | Parallel changes in one workspace | Optional composed local workspace over isolated Change state |
| Graphite | Stack review and merge automation | Native stack/cohort review, not a GitHub add-on |
| GitHub | Rulesets, Apps, Codespaces, environments, merge queue | Effect-aware policy, installation grants, workspaces, general Targets, Integration Cohorts |
| GitLab | Merge trains, confidential issues, integrated evidence/security | Cohort validation and disclosure-aware collaboration/evidence |
| Gitea/Forgejo | Lightweight self-hosting, mirrors, unit permissions, broad packages | BYOCF, portable drivers, surface-level permissions, artifact adapters |
| OneDev | Local CI, browser workspaces, AI users, TOD/skills | Fast feedback and model-independent agent integration as parity |
| Azure DevOps | Work-item traceability and formal test management | Intent-to-Change-to-Evidence lineage |
| Bitbucket | Jira ecosystem and custom merge checks | Integration adapters and policy extension points |
| Codeberg/SourceHut | Governance, transparency, no tracking, public ownership | Open core/protocols, exportability and community-operable deployments |
| Perforce | Path ACLs, locking, large assets | Separate Source Spaces plus optional artifact locks |
| Radicle | Signed local collaboration objects | Portable signed event/evidence formats and later federation |
| Fossil | Self-contained project metadata | Complete project export, restore and local inspection |

## Integrate instead of owning

Anyam should own trust decisions and normalized evidence, while integrating specialized providers:

- SAST, DAST, fuzzing, malware, dependency and license scanners.
- External package registries beyond generic/OCI-first support.
- Jira, Linear, Azure Boards, Slack, Teams, email and service desks.
- macOS, Windows, GPU, ARM, hardware-in-loop and private-network runners.
- Cloud/application/package/store/model/fleet Target adapters.
- Enterprise IdPs, device-posture providers and Cloudflare Access.
- Codex, Claude Code, Cursor, GitHub Copilot, GitLab Duo, Rovo and future agents.
- Observability and incident platforms.

The verifier contract must return typed findings, evidence digests, disclosure class, reproduction metadata and artifact identities. Scanner output is evidence input; scanner implementation is not Anyam's core product.

## Deliberate exclusions

| Exclusion | Reason |
|---|---|
| New low-level object database or Git wire protocol in v1 | Adoption and correctness risk; Source Spaces can compose normal Git repositories |
| Arbitrary hidden files inside one Git object graph | Metadata leakage and incompatible public history; separate Source Spaces are safer |
| Full GitHub Actions behavior/marketplace compatibility | Huge semantic and supply-chain surface; use a small portable action contract and selected adapters |
| Every package registry implementation | Maintenance cost unrelated to differentiation |
| Proprietary built-in coding model | Model choice and trust-zone policy are product requirements |
| Silent AI merge | Conflicts and evidence must remain explicit and reviewable |
| Direct agent or normal-user canonical writes | Violates the protected landing invariant |
| Built-in scanner engines | Separate specialist category; normalize results instead |
| Full ITSM, portfolio suite, proprietary browser IDE | Would recreate GitLab/Azure breadth without strengthening the source model |
| GitHub-scale public social network at launch | Network-effect battle; mirror public Source Spaces to existing networks |
| Peer-to-peer replication and federation in v1 | Identity, moderation and availability complexity before core proof |
| Native Mercurial support in v1 | Git compatibility is the adoption path; keep provider interfaces open |

## Defensible differentiation tests

A capability counts as product differentiation only if it passes an observable end-to-end demonstration. The initial proof should show:

1. One Project contains public, commercial, internal and restricted Source Spaces stored behind independent authority boundaries.
2. A public contributor clones a normal Git public projection and cannot discover private space names, paths, object IDs, contributors, timing, test names or metadata.
3. An authorized developer sees a single composed Project View and unified status without managing submodules or coordinating repositories manually.
4. One stable Change updates a public contract, private implementation, internal deployment configuration and restricted verifier atomically.
5. The public source profile remains dependency-closed, buildable and testable without private implementation.
6. A Sealed Verifier evaluates the private combination and returns only disclosure-approved Evidence.
7. An external agent receives an exact Context Manifest and a temporary grant limited to allowed Source Spaces, Workspace, Change, tools, network, secrets usage and budget.
8. Neither human nor agent receives canonical write authority; a trusted landing service creates the new Project Revision after policy passes.
9. Community and commercial Releases are built from the same Project Revision with distinct artifact and disclosure manifests.
10. Complete Git histories, Changes, Intents, findings, Evidence, Releases, policies and audit records export without the hosted Anyam service.

If the first vertical slice cannot demonstrate those ten properties, it is an agent-enabled forge, not the differentiated Anyam product.

## Stale, overstated or false claims corrected

| Earlier claim or implication | Current correction |
|---|---|
| Basic autonomous issue-to-PR agents could differentiate Anyam | False as positioning. GitHub, GitLab and OneDev provide this; Bitbucket now has agentic Pipelines. |
| OneDev was only a potential or narrow competitor | Stale. Its current Community Edition includes AI users, workspaces, TOD CLI/skills, CI repair and conflict resolution. |
| GitHub third-party Codex/Claude agent support is simply a mature first-class feature | Overstated. It is documented as public preview, even though the overall agent surface is broad. |
| GitLab's entire agent surface can be scored as beta/limited | Stale. Duo Agent Platform is GA for Premium/Ultimate; individual surfaces such as the Flows API remain Experiment. |
| Gitea and Forgejo Actions can be grouped as GitHub Actions compatible | False. Gitea targets compatibility where possible; Forgejo explicitly says it is familiar but not designed for compatibility. |
| Codeberg offers ordinary hosted CI comparable to commercial forges | Overstated. Woodpecker onboarding is manual/as-is and hosted Forgejo Actions is limited open alpha; self-hosted runners are the reliable path. |
| Codeberg does not offer private repositories | Too absolute. It allows limited private repositories, but says commercial private hosting is not its mission and recommends Forgejo. |
| Codeberg provides the full Forgejo/Gitea mirroring baseline | False. Codeberg has disabled pull mirrors; users can still push manually to mirrors. |
| SourceHut is a finished mainstream forge competitor | Overstated. The service still labels itself public alpha and deliberately rejects AI and mainstream PR-centric UX. |
| Azure DevOps is a continuing public-forge benchmark | Stale. New public projects are retired and existing public projects are scheduled to become private in 2027. |
| Radicle lacks private repositories and CI | Stale. It now has private repository support and an official CI broker, subject to important replication, at-rest and audit caveats. |
| GitButler is merely a GitHub companion | Stale. It supports arbitrary Git remotes, GitLab/self-hosted GitLab, a full CLI, agent setup and skills, while remaining a local workflow layer. |
| Gerrit topics prove atomic cross-repository changes | False. Official docs warn that cross-repository topic submission can partially succeed. |
| Fossil private branches solve selective source disclosure | False. Fossil treats all private branches together and cannot selectively synchronize or scrub one private branch. |
| GitHub Advanced Security is simply included with paid GitHub | False. Security capabilities vary by repository visibility and product; enterprise private-repository capabilities can require separate products/usage. |
| Every advanced Git idea is novel to Anyam | False. Stable changes, patch sets, operation logs, undo, stacks, conflict state and file ACLs all have established precedents. |
| Graphite stack batching is generally available | False; current documentation identifies batching as private beta. |
| Repository-level visibility is enough to support open-core development | False for the stated Anyam goal. It requires separate repositories and external synchronization rather than one atomic disclosure-aware project revision. |

## Product implications

### Positioning

Use:

> One project, multiple trust boundaries, one coherent change history—for humans and agents.

Avoid:

- “GitHub on Cloudflare.”
- “An open-source AI forge.”
- “Assign an issue to any coding agent.”
- “Stacked pull requests, but native.”

All four are either commodity, already served, or too narrow.

### Scope order

1. Prove Source Spaces, Project Views, Project Revisions, stable cross-space Changes, public projection and protected landing.
2. Prove one human and one external agent workflow with task capabilities, Context Manifest, Evidence and sealed verification.
3. Provide enough Git, review, CI, artifact, release, export and policy parity for real use.
4. Add Publication Changes, stacks/cohorts, effect-aware policy, model trust zones and external runners.
5. Expand packages, enterprise identity, public ecosystem, federation and specialized project adapters only after the kernel works.

### Pricing posture

Do not compete only on per-seat forge pricing. GitHub Team is inexpensive, Azure DevOps Basic is inexpensive, OneDev Enterprise is $6/user/month, and Gitea/Forgejo can be self-hosted free. Anyam's monetizable value is safer agent throughput, governed public/private composition, evidence retention, managed execution, enterprise policy and customer-account operation. The open edition must remain useful without a hosted Anyam dependency.

## Source and refresh boundary

This document is a documentation snapshot, not a hands-on bake-off. It does not measure performance, support quality, undocumented APIs, installation effort, migration fidelity, user satisfaction, or private roadmap commitments.

The following claims are especially likely to drift and must be refreshed before roadmap or commercial commitments:

- AI agent availability, model support, billing and maturity labels.
- GitHub, GitLab, Gitea, OneDev, Azure DevOps and Bitbucket prices/tier gates.
- Forgejo federation and Actions behavior.
- Codeberg CI availability and quotas.
- Graphite beta features.
- Licensing or hosted/self-managed packaging.

Absence claims are deliberately narrow: “no first-class equivalent found in the reviewed official documentation as of 1 August 2026.” Before using an absence claim in marketing, run a product demo or trial, inspect current release notes, and ask the vendor to confirm.

This baseline should be refreshed at the end of the Anyam kernel prototype and before any public competitive positioning.
