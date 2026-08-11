/**
 * The Realm coordinator is only callable through an internal Worker binding.
 * The marker is an additional routing invariant; it is not a bearer secret and
 * must never be treated as user authentication.
 */
export const REALM_COORDINATOR_INTERNAL_HEADER = "x-anyam-coordinator-internal" as const;
export const REALM_COORDINATOR_INTERNAL_VALUE = "anyam-worker-v1" as const;
