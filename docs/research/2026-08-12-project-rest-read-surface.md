# Project-scoped REST read-surface qualification

This note records the private-alpha boundary implemented for [Wayfinder ticket
156](https://github.com/Whyme-Labs/anyam/issues/156).

## Qualified surface

The Realm Worker now exposes an owner-authenticated `GET
/api/projects/{projectId}` route. The edge validates the host-only owner
session, forwards the durable kernel session and one URL-decoded Project
identifier to the existing Authority Coordinator `project.inspect` boundary,
and returns the Coordinator's Project summary unchanged.

The summary contains the Project, canonical Project Revision, visible Source
Spaces, project-scoped counts, and a credential-free read-only receipt. The
edge never assembles a snapshot, transfers source objects, or receives
canonical write authority.

## Failure boundary

Unauthenticated callers receive a typed `401`. Unknown Projects use a safe
`404` without disclosing private identifiers. Empty, malformed, encoded-path,
or unsupported-method requests return typed actionable errors. Kernel session
identifiers and credential material are never included in the response.

## Evidence

`test/realm-rest-project-read.test.ts` covers authentication ordering,
coordinator binding, project path decoding, hidden-project concealment,
malformed paths, unsupported methods, and credential-free responses.

This is a read-only private-alpha surface. REST mutations, task-grant
delegation, source transfer, public visibility, and a web console remain
separate Wayfinder boundaries.
