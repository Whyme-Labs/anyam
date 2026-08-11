# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues in `Whyme-Labs/anyam`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a body file for multiline content.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments with `jq` and fetching labels when needed.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `gh issue edit <number> --remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside this checkout.

## Pull requests as a triage surface

**PRs as a request surface: no.**

When changed to `yes`, external pull requests run through the same labels and states as issues using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` author associations.
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit --add-label` or `--remove-label`, and `gh pr close`.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with `gh pr view <number>` and fall back to `gh issue view <number>`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `Whyme-Labs/anyam`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The `wayfinder` skill represents a map as one GitHub issue and its tickets as child issues.

- **Map**: one issue labelled `wayfinder:map`, containing Notes, Decisions so far, Not yet specified, and Out of scope.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add it to a task list in the map and put `Part of #<map>` at the top of the child body. Apply one `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with `gh api --method POST repos/Whyme-Labs/anyam/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>`, where the blocker database ID comes from `gh api repos/Whyme-Labs/anyam/issues/<number> --jq .id`. If dependencies are unavailable, use a `Blocked by: #<number>, #<number>` line.
- **Frontier**: among the map's open children, select the first issue with no open blocker and no assignee.
- **Claim**: `gh issue edit <number> --add-assignee @me` before doing any work.
- **Resolve**: comment with the answer, close the issue, then append a linked one-line gist to the map's Decisions-so-far section.
