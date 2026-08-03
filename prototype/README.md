# Public-beta onboarding prototype

**Throwaway prototype for Wayfinder ticket #102.** It answers a logic/state
question, not a production implementation question:

> Can a technical user install and recover a customer-operated Realm, invite a
> team, create a hybrid public/private Project, accept safe public Changes, and
> see abuse, moderation, and cleanup boundaries without operating a finished
> social network?

Run the complete scripted journey:

```bash
npm run prototype:onboarding
```

Run one path:

```bash
npx tsx prototype/public-beta-onboarding.ts --scenario happy
npx tsx prototype/public-beta-onboarding.ts --scenario abuse
```

Use `--json` to make every state snapshot machine-readable:

```bash
npx tsx prototype/public-beta-onboarding.ts --scenario abuse --json
```

The prototype renders the complete relevant state after every action. The
public-contribution limit and cleanup observation are synthetic fixture
tripwires with `launchDefault=false`; they are not product quotas. A real
public-beta limit must replace them with an observed workload distribution and
provider receipt before publication.

The prototype intentionally keeps the following boundaries visible:

- installation and owner recovery precede Project creation;
- public contribution enters a destination-Realm quarantine, never private
  Source Spaces;
- a named tripwire denial includes the limit, configured value, request, and
  recovery action;
- moderation suspends intake without deleting canonical history; and
- cleanup removes only disposable fixture resources while retaining export,
  lineage, audit, and credential-free recovery.
