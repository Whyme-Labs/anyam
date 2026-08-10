# P3-22 live Hosted SaaS cross-Realm isolation qualification

Date: 2026-08-10
Worker: `anyam-p3-22-live-20260810`
URL: `https://anyam-p3-22-live-20260810.swmengappdev.workers.dev`
Deployment version: `6c5de221-71a7-4c97-9537-7c1e3a1c43ea`
Build revision: `bba3dea`
Account: `1e0170aaabc90ecf5f466128d1f0466a`
Protocol: `anyam.p3-22-hosted-saas-qualification/v1`

## Result

The disposable Hosted SaaS Worker passed the live two-Realm qualification. The
run used two synthetic Realms and host aliases:

- `realm:live-a` at `realm-a.hosted.invalid`
- `realm:live-b` at `realm-b.hosted.invalid`

The qualification passed:

- Realm registration and credential issuance.
- Same-Realm project create, read, mutate, enumerate, and export.
- Cross-Realm read, mutation, enumeration, and export denial.
- Disclosure-safe negative responses with no foreign Realm, project, or digest.
- Ignoring a caller-supplied Realm header when the host and credential disagree.
- Missing-credential rejection.
- Authorization-epoch revocation of Realm A.
- Replacement credential issuance after revocation.
- Wrong-audience token rejection.
- Unknown host/alias rejection.
- Coordinator reopen from its persisted credential-free snapshot.
- Credential-free recovery export and restore.
- Replacement credentials for both Realms after restore.
- Credential-free state inspection before cleanup.
- Exact cleanup followed by an asserted empty state (`realms=[]`, `observations=0`).

The live qualification receipt reported:

```text
status=succeeded
positive=register,create,read,mutate,enumerate,export
negative=foreign-read,foreign-mutation,foreign-enumeration,foreign-export,wrong-audience,unknown-host,missing-credential,caller-header-ignored,metadata-disclosure
recovery=authorization-epoch-revocation,replacement-credential,coordinator-reopen,credential-free-export,credential-free-restore,replacement-after-restore
cleanup=realms:2,projects:2,credentials:2,queueMessages:10,events:10,logs:12,cacheEntries:2,exports:1
credentialValues=not-printed
physicalIsolation=not-claimed
anyamLimits=none-added
```

The store cleanup receipt was:

```text
cleanup=exact-store; credentialMaterialStored=false; canonicalWrite=false
```

## Disposable-resource cleanup

After the successful qualification, only the named disposable resources were
removed:

```text
Worker deletion: successfully deleted `anyam-p3-22-live-20260810`
Post-delete `/health`: HTTP 404
Secret verification: exact cohort secret is inaccessible because the Worker is not found
```

The bootstrap secret value was never printed, committed, or written to the
repository. The Worker and its exact cohort secret are not part of the
production or customer-owned resource set.

## Boundary and remaining claim

This receipt qualifies the hosted Worker boundary and the shared coordinator's
logical Realm partitioning. It does not claim physical Cloudflare account,
Durable Object, or storage isolation between customer Realms. That remains a
separate deployment-topology decision and qualification.

No new public limit was introduced by this qualification. Any future capacity
number needs a measurement receipt before it becomes a tripwire.
