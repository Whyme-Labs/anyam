# Keep an unpublished Intent note while disconnected

Write a note in an ordinary local UTF-8 file using your editor. Include the
Intent and any Change Revision or other context you inspected in the note so
you can reconsider it after reconnecting. Successful local saving and reopening
depend on your editor and filesystem; Anyam does not create, synchronize,
encrypt, back up, or promise durability for this file.

When connected again, inspect the current Intent using the existing hosted CLI
and your existing owner session, then review the saved text:

```sh
anyam intent inspect intent:example --realm https://your-realm.example --json
```

Inspect uses a fresh Realm read. A connection failure does not produce an
offline success or publish the note. Update the note if the discussion or its
source basis changed. When you choose to publish, supply its path explicitly:

```sh
anyam intent comment intent:example \
  --body-file ./drafts/intent-note.md \
  --realm https://your-realm.example \
  --idempotency-key 'intent-note:example:review-1' \
  --json
```

The existing owner-session input and Intent disclosure rules still apply. Use
`--disclosure` when you need to select comment disclosure within the Intent's
permitted scope. Choose exactly one `--body <text>` or `--body-file <path>`.
File paths resolve from the shell's current directory, and the file must be a
nonempty UTF-8 regular file. Multiline text is sent through the same existing
Intent-comment endpoint and command semantics as inline text. The note is not
consumed or rewritten after success, failure, or a lost response.

For a lost response, inspect the current Intent and retry only the same
unchanged note with the same explicit idempotency key when appropriate. The
CLI does not retry automatically. A changed note needs a new command identity.
Without an explicit key, the existing CLI generates a new key for each
invocation; repeating that invocation can create another comment.

An Intent comment is discussion. It is not a Review Finding bound by Anyam to
an exact Change Revision, a Review Approval, Evidence, a Landing, or a
Promotion. A source-basis label inside the note is user-written context, not
authenticated execution or revision proof. `--body-file` is supported only by
`intent comment` and cannot be supplied to `pr review` or another command.

## Assessment of suggestion #363

[#363](https://github.com/Whyme-Labs/anyam/issues/363) is adapted to this existing
Intent workflow. ADR 0098 already provides durable Intent comments, and the
CLI already supports selective current Intent inspection. A locally retained
file completes the useful unpublished-note path without creating another
collaboration or authority store.

The Project View cache proposal is deferred. The current owner control room
deliberately uses `no-store` and has no client-storage or discussion editor.
The local agent review packet already inspects recorded local observations,
with explicit unknown, stale, missing and unbound states. Neither establishes
the need for a new shared cache of private Project View metadata. Such a cache
would need evidence of user value plus explicit scope, actor/account-switch,
expiry, removal and missing-content behavior before adoption. No browser cache,
CRDT, transport cursor, mirror synchronization, or offline approval is added.

`test/cli-intent-draft.test.ts` exercises the actual CLI with owned local files
and an in-process Realm transport double: reopen/multiline publication, invalid
input without a request, lost-response retention and explicit same-key retry,
fresh inspection after disconnection, unchanged inline comments, and refusal
to supply a note to an approval command. These are local observations; live
Realm operation, production storage reliability, human adoption and Cloudflare
Artifacts remain separate gates.
