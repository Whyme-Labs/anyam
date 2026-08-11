# P3-13 Realm-local identity and Federation boundary qualification

Date: 2026-08-03

Issue: [Decide whether Realm federation belongs in P3](https://github.com/Whyme-Labs/anyam/issues/101)

Protocol: `anyam.p3-realm-federation-boundary/v1`

Status: P3 Realm-local boundary accepted; Federation deferred as an explicit later adapter

## Question

Does P3/public beta require Realm-to-Realm identity Federation, or can
Realm-local membership plus approved upstream identity providers support public
contribution and customer-operated installs without weakening disclosure,
revocation, audit, or customer ownership?

## Decision receipt

```text
protocol=anyam.p3-realm-federation-boundary/v1
stage=public-beta
decision=realm-local-identity-sufficient
federation=p3-deferred; explicit-adapter-only
global-anyam-identity=not-required
cross-realm-credential=denied
cross-realm-membership=denied-by-default
public-contribution=destination-realm-projection-and-envelope
customer-operated-install=standalone-and-recoverable
private-metadata-disclosure=denied
source-realm-bearer-passthrough=denied
future-federation=requires-trust-disclosure-revocation-abuse-operational-receipts
assumption=default-under-no-contrary-input; reopenable
```

## Qualification method

The decision was checked against the accepted Realm identity and delegation
contracts and their existing tests. The qualification is framework-neutral and
credential-free; it does not claim live WebAuthn, OIDC discovery, MCP OAuth,
Git credential exchange, SAML, SCIM, or a production Federation provider.

The existing multi-Realm qualification in
`docs/research/2026-08-03-p3-2-multi-realm-identity-qualification.md` supplies
the provider-independent receipts for:

- distinct local Principal mappings for the same upstream issuer and subject;
- distinct relying-party IDs and passkey boundary;
- Realm-scoped team relationships and Source Space permissions;
- invalid cross-Realm and cross-audience credentials;
- `not_found` disclosure for hidden private Source Spaces;
- independent Grant revocation and authorization epochs; and
- credential-free snapshots and independent Audit/authorization state.

The Realm-owned delegation qualification in
`docs/adr/0040-realm-owned-agent-actors-and-human-to-agent-delegation.md` and
`test/realm-agent-delegation.test.ts` supplies the corresponding agent
boundary: a Realm-local agent Actor is created only through a human parent
Grant, child authority is narrowed, canonical promotion is denied, and
revocation cascades without revoking unrelated human sessions.

## Commands and observed evidence

```text
npx tsx --test test/realm-agent-delegation.test.ts — 5 passed
npm run typecheck — TypeScript clean
npm test — 105 passed
git diff --check — clean
```

The test names include:

```text
registers a Realm-owned agent and narrows human authority into a task grant
rejects agent scope widening and issues only task-scoped Git and MCP credentials
revokes all delegated authority without revoking the human session
parent Session revocation cascades to delegated agent Sessions, Tasks, Grants, and credentials
does not accept an agent or parent Grant from another Realm
```

The previously accepted P3-2 receipt additionally records that a shared
upstream identity, team name, and Source Space name did not create authority in
the other Realm, and that hidden resources were returned as `not_found` without
private metadata.

## Boundary

This receipt qualifies the P3 protocol and local kernel boundary. It does not
qualify:

- a live federation handshake or trust-anchor exchange;
- a production public gateway or anonymous abuse/rate-control posture;
- live WebAuthn/OIDC/MCP OAuth/token-broker provider behavior;
- external Realm policy translation, SAML, or SCIM;
- provider-specific residency, reliability, billing, or quota claims; or
- universal support for arbitrary cross-Realm Projects or Targets.

Those remain separate adapter or later-stage receipts. If Federation becomes a
P3 requirement, this ticket must be reopened with a concrete trust contract
and a new qualification plan; it must not be enabled by inference from a
matching issuer, project name, or Git mirror.
