import { createHash } from "node:crypto";

import { opaqueId, type ProjectExport, type Project, type SourceSpace } from "../kernel/contracts.ts";
import type {
  RepositoryDriver,
  RepositoryDriverDescriptor,
  RepositoryDriverHealth,
  RepositoryDriverResult,
  RepositoryHandle,
  RepositoryIntegrityReport,
  RepositoryOperationReceipt,
  RepositoryState,
} from "../portability/repository-driver.ts";
import { isCredentialFree as scanIsCredentialFree } from "../security/credential-material.ts";

export type {
  RepositoryDriver,
  RepositoryDriverDescriptor,
  RepositoryDriverHealth,
  RepositoryDriverResult,
  RepositoryHandle,
} from "../portability/repository-driver.ts";

export type AdapterSuccess<T> = {
  status: "succeeded";
  value: T;
};

export type AdapterFailure = {
  status: "failed";
  errorCode: string;
  message: string;
  retryable: boolean;
};

export type AdapterResult<T> = AdapterSuccess<T> | AdapterFailure;

export function isCredentialFree(value: unknown): boolean {
  return scanIsCredentialFree(value);
}

export interface Runner {
  execute(input: { actionId: string; snapshotId: string }): Promise<AdapterResult<{
    runId: string;
    outputDigest: string;
  }>>;
}

export interface TargetAdapter {
  proposePromotion(input: { releaseId: string; artifactType: string }): Promise<AdapterResult<{
    proposalId: string;
    releaseId: string;
    targetState: "proposed";
  }>>;
}

export interface IdentityProvider {
  authenticate(input: { externalSubject: string }): Promise<AdapterResult<{ principalId: string }>>;
}

export interface ProjectExporter {
  exportProject(input: {
    project: Project;
    sourceSpaces: readonly SourceSpace[];
  }): Promise<AdapterResult<ProjectExport>>;
  restoreProject(input: { projectExport: ProjectExport }): Promise<AdapterResult<{ restoredProjectId: string; digest: string }>>;
}

export class InMemoryRepositoryDriver implements RepositoryDriver {
  async describe(): Promise<RepositoryDriverResult<RepositoryDriverDescriptor>> {
    return {
      status: "succeeded",
      value: {
        protocol: "anyam.repository-driver/v1",
        id: "driver:in-memory",
        name: "In-memory RepositoryDriver",
        version: "v1",
        capabilities: {
          git: { clone: false, fetch: false, push: false, branch: false, tag: false, diff: false, commit: false, objectFormats: ["sha1"] },
          lifecycle: { create: true, import: false, export: false, restore: false, verify: false },
          lfs: { enumerate: false, export: false, restore: false },
          consistency: {
            durableBeforeAcknowledgement: "unsupported",
            linearizableRefPublication: "unsupported",
            readAfterWrite: "unsupported",
            replayAfterCacheLoss: "unsupported",
            exactExportRestore: "unsupported",
            receipt: "provider=in-memory; consistency=unsupported; providerFactsAreNotAnyamLimits=true",
          },
        },
      },
    };
  }

  async probe(): Promise<RepositoryDriverResult<RepositoryDriverHealth>> {
    return { status: "succeeded", value: { state: "healthy", receipt: "driver=in-memory; provider-authority=none" } };
  }

  async createRepository(input: { sourceSpaceId: string }): Promise<AdapterResult<RepositoryHandle>> {
    return { status: "succeeded", value: { repositoryId: opaqueId("repository"), sourceSpaceId: input.sourceSpaceId } };
  }

  async readSnapshot(input: { repository: RepositoryHandle }): Promise<AdapterResult<{ snapshotId: string }>> {
    return { status: "succeeded", value: { snapshotId: `${input.repository.repositoryId}:snapshot` } };
  }

  async inspectRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryState>> {
    const snapshot = await this.readSnapshot(input);
    return snapshot.status === "succeeded"
      ? {
        status: "succeeded",
        value: {
          repository: { ...input.repository },
          objectFormat: "sha1",
          defaultBranch: "main",
          refs: [{ name: "refs/heads/main", oid: snapshot.value.snapshotId }],
          generation: snapshot.value.snapshotId,
        },
      }
      : snapshot;
  }

  async observeRepository(input: Parameters<RepositoryDriver["observeRepository"]>[0]): Promise<RepositoryDriverResult<import("../kernel/contracts.ts").RepositoryObservation>> {
    return this.unsupported("observe", `${input.repository.repositoryId}:${input.workspaceId}`);
  }

  async deleteRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.unsupported("delete", input.repository.repositoryId);
  }

  async cloneRepository(input: { sourceSpaceId: string }): Promise<RepositoryDriverResult<RepositoryHandle>> {
    return this.unsupported("clone", input.sourceSpaceId);
  }

  async fetchRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.unsupported("fetch", input.repository.repositoryId);
  }

  async pushRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.unsupported("push", input.repository.repositoryId);
  }

  async createBranch(input: { repository: RepositoryHandle; name: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.unsupported("branch", `${input.repository.repositoryId}:${input.name}`);
  }

  async createTag(input: { repository: RepositoryHandle; name: string }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.unsupported("tag", `${input.repository.repositoryId}:${input.name}`);
  }

  async diffRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<{ text: string; digest: string }>> {
    return this.unsupported("diff", input.repository.repositoryId);
  }

  async commitRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<{ commitId: string; receipt: string }>> {
    return this.unsupported("commit", input.repository.repositoryId);
  }

  async listRefs(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<readonly never[]>> {
    return this.unsupported("list-refs", input.repository.repositoryId);
  }

  async compareAndSwapRefs(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryOperationReceipt>> {
    return this.unsupported("compare-and-swap", input.repository.repositoryId);
  }

  async exportRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<import("../portability/repository-driver.ts").RepositoryExportReceipt>> {
    return this.unsupported("export", input.repository.repositoryId);
  }

  async restoreRepository(input: { sourceSpaceId: string }): Promise<RepositoryDriverResult<import("../portability/repository-driver.ts").RepositoryRestoreReceipt>> {
    return this.unsupported("restore", input.sourceSpaceId);
  }

  async verifyRepository(input: { repository: RepositoryHandle }): Promise<RepositoryDriverResult<RepositoryIntegrityReport>> {
    return this.unsupported("verify", input.repository.repositoryId);
  }

  private unsupported<T>(operation: string, affectedObject: string): RepositoryDriverResult<T> {
    return {
      status: "failed",
      errorCode: `driver.${operation}_unsupported`,
      message: `In-memory RepositoryDriver cannot ${operation} ${affectedObject}; use LocalGitRepositoryDriver for Git round-trip operations.`,
      retryable: false,
      affectedObject,
      recoveryAction: "select a RepositoryDriver with the requested capability",
      receipt: `operation=${operation}; object=${affectedObject}; provider-authority=none`,
    };
  }
}

export class InMemoryRunner implements Runner {
  async execute(input: { actionId: string; snapshotId: string }): Promise<AdapterResult<{
    runId: string;
    outputDigest: string;
  }>> {
    return {
      status: "succeeded",
      value: {
        runId: opaqueId(`run-${input.actionId}`),
        outputDigest: `digest:${input.snapshotId}:${input.actionId}`,
      },
    };
  }
}

export class InMemoryTargetAdapter implements TargetAdapter {
  async proposePromotion(input: { releaseId: string; artifactType: string }): Promise<AdapterResult<{
    proposalId: string;
    releaseId: string;
    targetState: "proposed";
  }>> {
    return {
      status: "succeeded",
      value: {
        proposalId: opaqueId(`promotion-${input.artifactType}`),
        releaseId: input.releaseId,
        targetState: "proposed",
      },
    };
  }
}

export class InMemoryIdentityProvider implements IdentityProvider {
  async authenticate(input: { externalSubject: string }): Promise<AdapterResult<{ principalId: string }>> {
    return { status: "succeeded", value: { principalId: `principal:${input.externalSubject}` } };
  }
}

export class InMemoryProjectExporter implements ProjectExporter {
  async exportProject(input: {
    project: Project;
    sourceSpaces: readonly SourceSpace[];
  }): Promise<AdapterResult<ProjectExport>> {
    return {
      status: "succeeded",
      value: {
        protocol: "anyam.export/v1",
        version: "v1",
        exportId: opaqueId("export"),
        createdAt: new Date().toISOString(),
        project: { ...input.project, sourceSpaceIds: [...input.project.sourceSpaceIds] },
        sourceSpaces: input.sourceSpaces.map((space) => ({ ...space })),
        repositories: [],
        largeObjects: [],
        lineage: [],
        projectRevisions: [],
        changeRevisions: [],
        intents: [],
        intentComments: [],
        pullRequests: [],
        changes: [],
        evidence: [],
        artifacts: [],
        releases: [],
        targets: [],
        capabilityGrants: [],
        extensions: [],
        policies: [],
        auditEventIds: [],
        recoveryCheckpointIds: [],
        recovery: {
          checkpointId: opaqueId("checkpoint"),
          state: "verified",
          resumeAction: "rerun the in-memory export",
          receipt: "provider-authority=none; repositories=0",
        },
        integrity: {
          manifestDigest: "in-memory",
          repositoryDigests: [],
          credentialFree: true,
          receipt: "credentialFields=none",
        },
      },
    };
  }

  async restoreProject(input: { projectExport: ProjectExport }): Promise<AdapterResult<{ restoredProjectId: string; digest: string }>> {
    if (input.projectExport.protocol !== "anyam.export/v1" || !isCredentialFree(input.projectExport)) {
      return {
        status: "failed",
        errorCode: "unsafe-export",
        message: "Project export failed protocol or credential-safety validation.",
        retryable: false,
      };
    }
    return {
      status: "succeeded",
      value: {
        restoredProjectId: input.projectExport.project.id,
        digest: createHash("sha256").update(JSON.stringify(input.projectExport)).digest("hex"),
      },
    };
  }
}
