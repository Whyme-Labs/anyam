# Git Smart HTTP RepositoryDriver and Workspace-only pushes

Status: Accepted

Issue: [#149](https://github.com/Whyme-Labs/anyam/issues/149)

## Context

Anyam needs ordinary Git clone, fetch, and push without making a customer
provider's repository API the kernel. The existing local driver qualifies Git
object operations and the public gateway is intentionally read-only. Neither
one is enough for a customer-operated canonical repository plus disposable
Workspace repositories.

The transport must also preserve the Authority Plane boundary. A Git client
must not receive a canonical write credential, a token must not be persisted in
a repository handle or remote URL, and provider outages must return a durable
checkpoint and recovery action instead of a silent retry.

## Decision

Anyam exposes a Worker-compatible Git Smart HTTP gateway and a portable
`RepositoryDriver` implementation for Node/CLI clients:

```text
Git client
  -> SmartHttpRepositoryDriver
  -> short-lived aud:anyam:git credential
  -> Anyam Smart HTTP gateway
  -> customer-operated Git Smart HTTP upstream
```

The gateway accepts the standard `info/refs`, `git-upload-pack`, and
`git-receive-pack` routes under `/git/<repositoryId>.git/...` over HTTPS. It never
forwards the Anyam bearer token to the upstream provider. The upstream base is
configuration, not Project model state, and cannot contain embedded
credentials, a fragment, or a path outside the configured provider adapter.

Read credentials are repository-bound. Write credentials are repository- and
Workspace-bound. The gateway denies every write unless its explicit
`workspaceIdForRepository` mapping returns the same Workspace ID carried by the
credential. If that mapping is absent, writes are denied by default. The
driver rejects canonical push and compare-and-swap before invoking Git; only a
trusted Landing service may mutate canonical refs.

The Node driver delegates local inspection, commit, export, restore, and
verification to `LocalGitRepositoryDriver`. Source-object transfer uses Git
Smart HTTP with an environment-only `http.extraHeader`; tokens never appear in
arguments, remotes, handles, exports, or receipts. Workspace CAS uses
`--force-with-lease` and classifies stale provider rejection separately from
transport failure.

Repository creation remains a control-adapter operation. Smart HTTP has no
portable repository-create endpoint, so the control adapter creates or forks a
provider repository and the driver then clones it through the gateway.

## Qualification

The qualification test runs a real `git http-backend` CGI server behind the
Worker-compatible HTTPS gateway. The gateway's customer-upstream fixture uses
HTTP only behind an explicit qualification-only escape hatch; a normal
configuration rejects an insecure upstream. The Git client uses a
qualification-only trust bypass for the ephemeral self-signed gateway
certificate. It verifies:

1. real clone and fetch over Git Smart HTTP;
2. canonical push rejection at the driver and gateway;
3. Workspace push with an exact Workspace credential;
4. Project Revision CAS success, stale-ref rejection, and recovery;
5. bundle export, digest-checked restore, and fsck/bundle verification; and
6. provider outage recovery with a stable checkpoint for the same idempotency
   key.

The receipt reports customer-provider facts (transport, upstream fixture,
credential storage, and pack transfer) separately from Anyam policy
(`canonicalWrite=landing-only`). Fixture lease sizing is test-only evidence;
it is not an Anyam production token lifetime or provider capacity limit.

## Consequences

- Existing Git clients can use HTTPS without learning a new wire protocol.
- The kernel remains portable across Cloudflare Artifacts, a generic Git
  provider, or a later customer adapter.
- Workspace isolation is enforced at both the driver and gateway boundary.
- Canonical Landing remains the single authority for Project Revision changes.
- Provider-specific HTTP failures remain explicit and resumable.
- Provider repository creation and live customer deployment remain separate
  qualifications; this ADR does not claim a production Cloudflare deployment.

## Rejected alternatives

- **Put a long-lived PAT in `.git/config`:** leaks authority through local
  files, exports, logs, and copied workspaces.
- **Let Git push directly to canonical `main`:** collapses source transport
  into canonical authority and bypasses Change, Evidence, policy, and Landing.
- **Use MCP to transfer packfiles:** duplicates Git's efficient object protocol
  and makes agents responsible for transport details they do not need.
- **Make every gateway write-capable by default:** a missing provider mapping
  would become a canonical-write landmine, so the safe default is denial.
