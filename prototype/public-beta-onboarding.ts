/**
 * THROWAWAY PROTOTYPE — do not import from the product kernel.
 *
 * Question: does the smallest technical-user-first public-beta journey make
 * onboarding, public contribution, abuse response, recovery, and cleanup
 * obvious when seen as one state machine?
 *
 * This fixture deliberately uses synthetic tripwires. The receipt emitted by
 * the prototype is a measurement of this scenario, not a launch quota.
 */

type Scenario = "happy" | "abuse" | "all";
type Phase = "start" | "owner-claim" | "owner-ready" | "project-ready" | "public-ready" | "suspended" | "cleaned";
type Outcome = "accepted" | "denied" | "completed" | "blocked";

type Receipt = {
  id: string;
  measurement: string;
  configuredLimit?: number;
  requested?: number;
  observed?: number;
  launchDefault: false;
};

type Operation = {
  sequence: number;
  action: string;
  actor: string;
  outcome: Outcome;
  message: string;
  receipt?: Receipt;
};

type State = {
  phase: Phase;
  hostingMode: "customer-operated";
  installationId: string;
  realmId?: string;
  owner?: { id: string; recovery: "enrolled" };
  team: { invited: string[]; accepted: string[] };
  project?: {
    id: string;
    visibility: "hybrid";
    sourceSpaces: { public: string; private: string };
    canonicalRevision: string;
  };
  publicIntake: {
    status: "closed" | "open" | "suspended";
    requestsInFixtureWindow: number;
    accepted: number;
    denied: number;
    syntheticLimit: number;
    limitReceipt: string;
  };
  moderation: { status: "clear" | "suspended"; reason?: string };
  recovery: { exportReady: boolean; credentialsStored: false; cleanupState: "not-started" | "completed" };
  operations: Operation[];
  lastDecision?: {
    limit: string;
    configured: number | "state-boundary";
    requested: number | string;
    recoveryAction: string;
    receipt: string;
  };
};

const SYNTHETIC_LIMIT = 3;
const LIMIT_RECEIPT = "receipt:fixture-public-intake-window-v1";

function initialState(): State {
  return {
    phase: "start",
    hostingMode: "customer-operated",
    installationId: "installation:prototype-public-beta",
    team: { invited: [], accepted: [] },
    publicIntake: {
      status: "closed",
      requestsInFixtureWindow: 0,
      accepted: 0,
      denied: 0,
      syntheticLimit: SYNTHETIC_LIMIT,
      limitReceipt: LIMIT_RECEIPT,
    },
    moderation: { status: "clear" },
    recovery: { exportReady: false, credentialsStored: false, cleanupState: "not-started" },
    operations: [],
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class OnboardingPrototype {
  private state = initialState();

  private record(action: string, actor: string, outcome: Outcome, message: string, receipt?: Receipt): void {
    const operation: Operation = {
      sequence: this.state.operations.length + 1,
      action,
      actor,
      outcome,
      message,
      ...(receipt ? { receipt } : {}),
    };
    this.state.operations.push(operation);
    this.render(operation);
  }

  private render(operation: Operation): void {
    const snapshot = clone(this.state);
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ operation, state: snapshot }, null, 2)}\n`);
      return;
    }
    process.stdout.write(`\n[ACTION ${operation.sequence}] ${operation.actor} → ${operation.action}\n`);
    process.stdout.write(`${operation.outcome.toUpperCase()}: ${operation.message}\n`);
    if (operation.receipt) process.stdout.write(`RECEIPT: ${JSON.stringify(operation.receipt)}\n`);
    process.stdout.write(`STATE: ${JSON.stringify(snapshot, null, 2)}\n`);
  }

  install(): void {
    if (this.state.phase !== "start") {
      this.record("install", "customer", "blocked", "Installation already started; resume the recorded installation operation instead.");
      return;
    }
    this.state.phase = "owner-claim";
    this.state.realmId = "realm:prototype-customer";
    this.state.recovery.exportReady = true;
    this.record("install", "customer", "completed", "Customer account control is recorded; the Realm is ready for owner claim. No credential material was stored.");
  }

  claimOwner(): void {
    if (this.state.phase !== "owner-claim") {
      this.record("owner-claim", "customer", "blocked", "Owner claim is unavailable until the installation reaches owner-claim; resume the installation checkpoint.");
      return;
    }
    this.state.phase = "owner-ready";
    this.state.owner = { id: "principal:prototype-owner", recovery: "enrolled" };
    this.record("owner-claim", "customer", "accepted", "Owner is enrolled with passkey/OIDC adapter evidence and an external recovery path.");
  }

  inviteTeam(): void {
    if (this.state.phase !== "owner-ready" && this.state.phase !== "project-ready" && this.state.phase !== "public-ready") {
      this.record("invite-team", "owner", "blocked", "Team invitation requires an enrolled Realm owner; complete owner recovery enrollment first.");
      return;
    }
    this.state.team.invited.push("developer@example.test");
    this.state.team.accepted.push("developer@example.test");
    this.record("invite-team", "owner", "accepted", "One developer accepted a local Realm invitation; membership and Source Space access remain destination-Realm decisions.");
  }

  createProject(): void {
    if (this.state.phase !== "owner-ready") {
      this.record("create-project", "owner", "blocked", "Project creation requires a claimed owner with recovery enrolled; no Project was created.");
      return;
    }
    this.state.phase = "project-ready";
    this.state.project = {
      id: "project:video-player",
      visibility: "hybrid",
      sourceSpaces: { public: "source:player", private: "source:codec" },
      canonicalRevision: "project-revision:prototype-1",
    };
    this.record("create-project", "owner", "accepted", "Hybrid Project created: the public projection excludes the private codec Source Space while the canonical Project retains both.");
  }

  openPublicIntake(): void {
    if (this.state.phase !== "project-ready") {
      this.record("open-public-intake", "owner", "blocked", "Public intake requires a durable Project and explicit public Source Space projection.");
      return;
    }
    this.state.phase = "public-ready";
    this.state.publicIntake.status = "open";
    this.record("open-public-intake", "owner", "accepted", "Public clone and contribution intake are open; private Source Space metadata is not projected.");
  }

  submitPublicChange(): void {
    const request = this.state.publicIntake.requestsInFixtureWindow + 1;
    this.state.publicIntake.requestsInFixtureWindow = request;
    const receipt: Receipt = {
      id: LIMIT_RECEIPT,
      measurement: "synthetic fixture event window; observed healthy requests before the first denial",
      configuredLimit: SYNTHETIC_LIMIT,
      requested: request,
      observed: request,
      launchDefault: false,
    };
    if (this.state.publicIntake.status === "suspended") {
      this.state.publicIntake.denied += 1;
      this.state.lastDecision = {
        limit: "public-intake-state",
        configured: "state-boundary",
        requested: request,
        recoveryAction: "owner or moderator reviews the suspension before reopening public intake",
        receipt: "receipt:fixture-moderation-suspension-v1",
      };
      this.record("submit-public-change", "anonymous-contributor", "denied", "Public intake is suspended; the request was not materialized as a Change.", {
        id: "receipt:fixture-moderation-suspension-v1",
        measurement: "synthetic moderation state boundary",
        requested: request,
        launchDefault: false,
      });
      return;
    }
    if (this.state.publicIntake.status !== "open") {
      this.state.publicIntake.denied += 1;
      this.record("submit-public-change", "anonymous-contributor", "denied", "Public intake is closed; authenticate or wait for the owner to open the destination projection.");
      return;
    }
    if (request > SYNTHETIC_LIMIT) {
      this.state.publicIntake.denied += 1;
      this.state.lastDecision = {
        limit: "public-contribution-requests-per-fixture-window",
        configured: SYNTHETIC_LIMIT,
        requested: request,
        recoveryAction: "wait for the window to reset, authenticate for a higher-grant path, or ask the owner to review the intake policy",
        receipt: LIMIT_RECEIPT,
      };
      this.record("submit-public-change", "anonymous-contributor", "denied", `The public contribution tripwire was reached; requested ${request} while the configured fixture limit is ${SYNTHETIC_LIMIT}.`, receipt);
      return;
    }
    this.state.publicIntake.accepted += 1;
    this.record("submit-public-change", "anonymous-contributor", "accepted", "Public Change Revision accepted into a destination-Realm quarantine; private Source Space content and metadata remain undisclosed.", receipt);
  }

  suspendPublicIntake(): void {
    if (this.state.publicIntake.status !== "open") {
      this.record("suspend-public-intake", "moderator", "blocked", "Only open public intake can be suspended; inspect the current moderation state.");
      return;
    }
    this.state.phase = "suspended";
    this.state.publicIntake.status = "suspended";
    this.state.moderation = { status: "suspended", reason: "abuse-shaped fixture traffic" };
    this.record("suspend-public-intake", "moderator", "accepted", "Public intake is suspended without deleting Project history, accepted Changes, or recovery material.");
  }

  reopenPublicIntake(): void {
    if (this.state.publicIntake.status !== "suspended") {
      this.record("reopen-public-intake", "owner", "blocked", "Reopening requires an active moderation suspension and an owner review.");
      return;
    }
    this.state.phase = "public-ready";
    this.state.publicIntake.status = "open";
    this.state.moderation = { status: "clear" };
    this.record("reopen-public-intake", "owner", "accepted", "Owner review cleared the fixture suspension; reopening is explicit and audited.");
  }

  cleanup(): void {
    if (!this.state.project) {
      this.record("cleanup", "owner", "blocked", "Cleanup requires a Project export/recovery boundary; no resources were deleted.");
      return;
    }
    this.state.phase = "cleaned";
    this.state.publicIntake.status = "closed";
    this.state.recovery.cleanupState = "completed";
    this.record("cleanup", "owner", "completed", "Disposable preview/intake resources are cleaned; Project export, canonical lineage, audit, and credentials-free recovery remain.", {
      id: "receipt:fixture-cleanup-v1",
      measurement: "synthetic fixture cleanup inventory; no provider resource deletion claimed",
      observed: 1,
      launchDefault: false,
    });
  }

  run(actions: readonly (() => void)[]): void {
    for (const action of actions) action();
  }
}

function scenarioFromArgs(): Scenario {
  const index = process.argv.indexOf("--scenario");
  const value = index >= 0 ? process.argv[index + 1] : "all";
  if (value === "happy" || value === "abuse" || value === "all") return value;
  throw new Error(`Unknown scenario ${String(value)}; use --scenario happy, abuse, or all.`);
}

function runHappy(): void {
  process.stdout.write("\n=== Anyam public-beta onboarding prototype: healthy technical-user path ===\n");
  const prototype = new OnboardingPrototype();
  prototype.run([
    () => prototype.install(),
    () => prototype.claimOwner(),
    () => prototype.inviteTeam(),
    () => prototype.createProject(),
    () => prototype.openPublicIntake(),
    () => prototype.submitPublicChange(),
    () => prototype.cleanup(),
  ]);
}

function runAbuse(): void {
  process.stdout.write("\n=== Anyam public-beta onboarding prototype: abuse and recovery path ===\n");
  const prototype = new OnboardingPrototype();
  prototype.run([
    () => prototype.install(),
    () => prototype.claimOwner(),
    () => prototype.createProject(),
    () => prototype.openPublicIntake(),
    () => prototype.submitPublicChange(),
    () => prototype.submitPublicChange(),
    () => prototype.submitPublicChange(),
    () => prototype.submitPublicChange(),
    () => prototype.suspendPublicIntake(),
    () => prototype.submitPublicChange(),
    () => prototype.reopenPublicIntake(),
    () => prototype.submitPublicChange(),
    () => prototype.cleanup(),
  ]);
}

const scenario = scenarioFromArgs();
if (scenario === "happy" || scenario === "all") runHappy();
if (scenario === "abuse" || scenario === "all") runAbuse();
