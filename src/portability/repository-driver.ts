import type {
  GitObjectFormat,
  GitRef,
  RepositoryObservation,
  RepositoryExport,
} from "../kernel/contracts.ts";

export type RepositoryHandle = {
  repositoryId: string;
  sourceSpaceId: string;
};

export type RepositoryDriverSuccess<T> = {
  status: "succeeded";
  value: T;
};

export type RepositoryDriverFailure = {
  status: "failed";
  errorCode: string;
  message: string;
  retryable: boolean;
  affectedObject?: string;
  checkpointId?: string;
  recoveryAction?: string;
  receipt?: string;
  budget?: {
    name: string;
    limit: string;
    asked: string;
    receipt: string;
  };
};

export type RepositoryDriverResult<T> = RepositoryDriverSuccess<T> | RepositoryDriverFailure;

/**
 * A capability state is deliberately not boolean. `unverified` means the
 * driver may provide the behavior but Anyam has no receipt for this provider
 * boundary; `unsupported` means the driver does not provide it.
 */
export type RepositoryDriverCapabilityState = "observed" | "unverified" | "unsupported";

export type RepositoryDriverConsistencyCapabilities = {
  durableBeforeAcknowledgement: RepositoryDriverCapabilityState;
  linearizableRefPublication: RepositoryDriverCapabilityState;
  readAfterWrite: RepositoryDriverCapabilityState;
  replayAfterCacheLoss: RepositoryDriverCapabilityState;
  exactExportRestore: RepositoryDriverCapabilityState;
  receipt: string;
};

export type RepositoryDriverCapabilities = {
  git: {
    clone: boolean;
    fetch: boolean;
    push: boolean;
    branch: boolean;
    tag: boolean;
    diff: boolean;
    commit: boolean;
    objectFormats: readonly GitObjectFormat[];
  };
  lifecycle: {
    create: boolean;
    import: boolean;
    export: boolean;
    restore: boolean;
    verify: boolean;
  };
  lfs: {
    enumerate: boolean;
    export: boolean;
    restore: boolean;
  };
  consistency: RepositoryDriverConsistencyCapabilities;
};

export type RepositoryDriverDescriptor = {
  protocol: "anyam.repository-driver/v1";
  id: string;
  name: string;
  version: string;
  capabilities: RepositoryDriverCapabilities;
};

export type RepositoryDriverHealth = {
  state: "healthy" | "degraded" | "unavailable";
  receipt: string;
};

export type RepositoryState = {
  repository: RepositoryHandle;
  objectFormat: GitObjectFormat;
  defaultBranch: string | null;
  refs: readonly GitRef[];
  generation: string;
};

export type RepositoryOperationReceipt = {
  operationId: string;
  repositoryId: string;
  sourceSpaceId: string;
  receipt: string;
};

export type RepositoryExportReceipt = {
  repository: RepositoryExport;
  bundlePath: string;
  lfsObjectPaths: Readonly<Record<string, string>>;
  receipt: string;
};

export type RepositoryRestoreReceipt = {
  repository: RepositoryHandle;
  state: RepositoryState;
  receipt: string;
};

export type RepositoryIntegrityReport = {
  repositoryId: string;
  refsMatch: boolean;
  objectFormat: GitObjectFormat;
  bundleVerified: boolean;
  fsckPassed: boolean;
  lfsComplete: boolean;
  receipt: string;
};

export type RepositoryDriver = {
  describe(): Promise<RepositoryDriverResult<RepositoryDriverDescriptor>>;
  probe(): Promise<RepositoryDriverResult<RepositoryDriverHealth>>;
  createRepository(input: {
    sourceSpaceId: string;
    directory?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryHandle>>;
  inspectRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryState>>;
  observeRepository(input: {
    repository: RepositoryHandle;
    workspaceId: string;
    projectViewId: string;
    expectedCommitOid: string;
    expectedTreeOid?: string;
    expectedBaseCommitOid: string;
    expectedObjectFormat?: GitObjectFormat;
  }): Promise<RepositoryDriverResult<RepositoryObservation>>;
  deleteRepository(input: {
    repository: RepositoryHandle;
    expectedGeneration?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>>;
  cloneRepository(input: {
    sourceSpaceId: string;
    source: string;
    destination?: string;
    mirror?: boolean;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryHandle>>;
  fetchRepository(input: {
    repository: RepositoryHandle;
    remote?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>>;
  pushRepository(input: {
    repository: RepositoryHandle;
    remote?: string;
    refs?: readonly string[];
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>>;
  createBranch(input: {
    repository: RepositoryHandle;
    name: string;
    startPoint?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>>;
  createTag(input: {
    repository: RepositoryHandle;
    name: string;
    target?: string;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>>;
  diffRepository(input: {
    repository: RepositoryHandle;
    base?: string;
    compare?: string;
  }): Promise<RepositoryDriverResult<{ text: string; digest: string }>>;
  commitRepository(input: {
    repository: RepositoryHandle;
    message: string;
    paths?: readonly string[];
    author?: { name: string; email: string };
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<{ commitId: string; receipt: string }>>;
  listRefs(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<readonly GitRef[]>>;
  compareAndSwapRefs(input: {
    repository: RepositoryHandle;
    expected: Readonly<Record<string, string | null>>;
    desired: Readonly<Record<string, string | null>>;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>>;
  exportRepository(input: {
    repository: RepositoryHandle;
    destination: string;
    refs?: readonly string[];
    checkpointId?: string;
  }): Promise<RepositoryDriverResult<RepositoryExportReceipt>>;
  restoreRepository(input: {
    sourceSpaceId: string;
    bundlePath: string;
    destination: string;
    expectedDigest?: string;
    lfsObjects?: readonly {
      oid: string;
      sourcePath: string;
      digest?: string;
    }[];
    refs?: readonly GitRef[];
    defaultBranch?: string | null;
    idempotencyKey?: string;
  }): Promise<RepositoryDriverResult<RepositoryRestoreReceipt>>;
  verifyRepository(input: {
    repository: RepositoryHandle;
    expected?: RepositoryExport;
    bundlePath?: string;
  }): Promise<RepositoryDriverResult<RepositoryIntegrityReport>>;
};
