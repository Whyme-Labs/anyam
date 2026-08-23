# Filesystem Artifact containment

Status: Accepted

Issue: [#254](https://github.com/Whyme-Labs/anyam/issues/254)

## Context

The Cloudflare Worker Target can read a verified Artifact from a local
qualification workspace. A lexical path check is not a filesystem trust
boundary: root-relative `.git` paths, symlinks, directories, FIFOs, devices,
and path aliases can make the broker read something other than the verified
regular file.

## Decision

The filesystem reader treats the workspace root as a resolved realpath and
requires every path component to be a non-symlink component below that root.
It rejects every case-insensitive `.git` segment, absolute or escaping paths,
non-directory intermediate components, and non-regular output objects before
opening the file. The final open uses no-follow and non-blocking flags where
the host provides them, then verifies the opened descriptor is still a
regular file before reading and digest-checking the bytes.

The map/object-store reader remains the preferred production boundary. The
filesystem reader is limited to local and qualification workflows and emits a
reasoned, credential-free receipt for every rejected boundary.

## Consequences

- Root-relative metadata and symlink escapes fail closed.
- FIFOs, devices, directories, and other special files cannot block or become
  Artifact inputs.
- A regular file is still checked against its immutable Artifact digest after
  opening.
- The returned bytes remain necessary for the Worker upload API; callers that
  need aggregate size or streaming limits must enforce those at the enclosing
  Artifact publication boundary.

## Rejected alternatives

- **Lexical containment only:** aliases and symlinks can escape the root.
- **`readFile` without type checks:** special files can block or expose an
  unintended host object.
- **Treat `.git` as one literal path:** `.git/config` and case variants remain
  reachable through ordinary path resolution.

