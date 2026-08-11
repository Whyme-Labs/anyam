# P3-2 multi-Realm team identity and delegated capability qualification

Date: 2026-08-03
Issue: [Qualify multi-Realm team identity and delegated capability](https://github.com/Whyme-Labs/anyam/issues/82)
Status: Realm-local identity, team membership, capability intersection, audience isolation, revocation, and disclosure boundaries passed in the framework-neutral kernel; first-class agent identity and live provider authentication remain unqualified

## Question

Can two customer Realms and their teams use Realm-local membership, approved
upstream OIDC, Source Space permissions, task-scoped capabilities, and
separate credential audiences without cross-Realm authority or disclosure?

## Qualification method

The local `RealmIdentityPolicy` contract was exercised with two independent
instances:

```text
Realm Alpha
  id=realm:alpha
  relyingPartyId=alpha.example.test
  owner=principal:alpha-owner
  member=principal:alpha-member

Realm Beta
  id=realm:beta
  relyingPartyId=beta.example.test
  owner=principal:beta-owner
  member=principal:beta-member
```

Both Realms registered the same fixture OIDC issuer and upstream subject. Each
Realm linked that identity to its own local member Principal. Each Realm also
used the same team name (`team:video-player`) and Source Space names to test
that names do not create cross-Realm authority.

The harness was local and credential-free. Passkey assertions and OIDC
verification were adapter fixtures (`verified: true`); no live WebAuthn,
OIDC discovery, token endpoint, or external identity provider was exercised.

## Receipts

| Journey | Receipt |
| --- | --- |
| Realm separation | `realm:alpha` and `realm:beta` remained distinct; relying-party IDs were distinct and an Alpha passkey presented to Beta's relying-party ID was rejected as `auth.passkey_invalid` |
| Realm-local OIDC mapping | Shared upstream issuer/subject mapped to `principal:alpha-member` in Alpha and `principal:beta-member` in Beta; the local Principal IDs were distinct |
| Team membership | `team:video-player` was represented by Realm-scoped contributor relationships; the same team subject in Beta did not grant Alpha membership |
| Owner/member roles | Each owner authenticated with a Realm-bound passkey; each member authenticated through the linked OIDC fixture; member Source Space access was limited to the public player Source Space |
| Source Space permissions | Alpha and Beta each exposed `public-player` to owner/member and hid `private-codec` from the member; the hidden-resource result was `not_found` with no private Source Space identifier in the explanation |
| Task-scoped capability | Member Tasks and Grants were bound to the Principal, Actor, Client, Session, Project, Source Space, Workspace, Change, model provider, effects, credential classes, and expiry |
| Credential audiences | Git and MCP credentials carried separate audiences (`aud:anyam:git`, `aud:anyam:mcp`); an Alpha Git credential failed MCP validation and an Alpha credential was invalid in Beta |
| Revocation | Revoking Alpha's member Grant revoked both issued Alpha credentials while Beta's MCP credential remained valid |
| Authorization epoch | Activating a new Alpha policy epoch made an older Alpha credential stale while the Beta credential remained valid |
| Credential storage | Snapshots contained credential records without token values; the harness observed `credentialMaterialStored=false` |
| Member denied operation | A contributor's protected production promotion returned `forbidden` with missing role/Grant authority |

The harness output was:

```text
protocol=anyam.multi-realm-identity-qualification/v1
status=partial
realms=realm:alpha,realm:beta
realmIsolation=distinct-local-principals-and-rp-ids
oidcLocalMapping=principal:alpha-member,principal:beta-member
teamRelationship=team:video-player; role=contributor; realmScoped=true
credentialAudiences=git:aud:anyam:git; mcp:aud:anyam:mcp
crossRealmCredential=invalid
crossAudienceCredential=invalid
memberPromotion=forbidden; code=forbidden
crossRealmPrivate=not_found; metadataDisclosed=false
grantRevocation=alpha-credentials-revoked; beta-credential-still-valid=true
policyEpoch=alpha-credential-stale; beta-credential-still-valid=true
credentialMaterialStored=false
agentActor=not-qualified; observedActors=4; agentActors=0; taskActorKind=human
followUp=first-class-agent-actor-and-human-to-agent-delegation-required
```

## Qualification boundary

The Realm policy kernel provides a credible cross-Realm boundary for human
Principal, team relationship, Source Space, task Grant, credential audience,
revocation, and disclosure decisions. The result is not a production identity
provider qualification:

- WebAuthn signature verification and OIDC discovery/token exchange remain
  adapter responsibilities and were not run against a live provider.
- `RealmIdentityPolicy` creates human Actors from authenticated Sessions. A
  Task may carry a model provider and delegated capabilities, but this
  qualification observed `taskActorKind=human`, `agentActors=0`, and no
  first-class Realm API that creates an `ActorKind="agent"` or preserves a
  separate agent identity through human-to-agent delegation.
- The local `LocalAgentManager`/MCP broker contract is tested separately and
  does not yet prove a Realm identity bridge, Realm-local agent enrollment, or
  cross-Realm agent revocation.
- No live HTTP MCP OAuth, Git credential exchange, DPoP, RFC 8693 token
  exchange, SAML, or SCIM path was exercised.

The implementation follow-up is to add a Realm-owned agent Actor and an
explicit human-to-agent delegation boundary that preserves principal, actor,
client, session, task, parent Grant, model policy, audience, and revocation
lineage. It must continue to deny canonical writes and cross-Realm use.

No production credential lifetime or quota is inferred from this fixture. The
existing policy values remain configurable tripwires and require real adapter
receipts before customer-facing limits are published.
