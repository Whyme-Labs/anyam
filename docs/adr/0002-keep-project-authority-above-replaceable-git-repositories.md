---
status: accepted
---

# Keep Project authority above replaceable Git repositories

Every Git-backed Source Space has a Canonical Repository, and every writable Change uses isolated Workspace Repositories. Standard Git commits, branches, tags, clone, fetch, and push remain the source-object compatibility surface, but a Project Revision is the only authoritative coherent state across Source Spaces.

Repository providers sit behind `RepositoryDriver` and the Realm-owned Git Gateway. Only Landing receives Canonical Repository write authority. After the authoritative Project Revision compare-and-swap, Anyam reconciles ordinary Git refs idempotently from that manifest; provider events are wake-up hints rather than state authority.

A release may claim Customer-operated source hosting only when a production-qualified repository driver runs in the customer's Cloudflare account. Cloudflare Artifacts may satisfy that requirement after general availability and conformance testing. If it cannot, an open-source Cloudflare-native driver must qualify or the release remains an integration preview. A generic external Git remote is a portability and recovery adapter, not a required Customer-operated dependency.

## Consequences

- One public/private boundary is one Source Space object graph and Canonical Repository, never branches or hidden paths in a shared repository.
- Humans and agents receive short-lived write authority only for Workspace Repositories; canonical writes cannot bypass Landing, policy, Evidence, or Project Revision compare-and-swap.
- Git refs may temporarily lag the Project Revision during failure recovery, but they cannot define a competing Project state; later Landing remains serialized until reconciliation completes.
- HTTPS Smart HTTP is required. SSH, provider-native forks, events, partial clone, atomic multi-ref push, archives, and native LFS are optional capabilities rather than correctness dependencies.
- Public source remains anonymously cloneable through the Realm Git Gateway without GitHub or another forge.
- Git LFS uses a separately portable Large Object Store and complete export/restore verification.
- Bidirectional mirrors import remote commits as proposed Changes and export only landed refs with expected-old-OID checks; divergence becomes an explicit Conflict.
- Repository import, export, restore, integrity, credential isolation, public disclosure, failure recovery, scale, and provider migration are release gates rather than documentation assumptions.

## Rejected alternatives

- Treating latest repository branch heads as the Project would compose states that never existed or passed policy.
- Giving humans or agents canonical write tokens would bypass the cross-space authority model.
- Encoding authoritative Anyam metadata in Git refs, notes, or commit messages would pollute mirrors and leak internal state.
- Making GitHub, GitLab, or another external forge the fallback would contradict a Customer-operated Realm.
- Building a new Git server immediately would spend the initial product wedge on protocol infrastructure; the native driver is a gated contingency if managed Cloudflare storage cannot qualify.
