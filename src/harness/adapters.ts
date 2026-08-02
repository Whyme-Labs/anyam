import { createHash } from "node:crypto";

import { opaqueId, type ProjectExport, type Project, type SourceSpace } from "../kernel/contracts.ts";

export type RepositoryHandle = {
  repositoryId: string;
  sourceSpaceId: string;
};

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

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase();
    return normalizedKey.includes("token")
      || normalizedKey.includes("password")
      || normalizedKey.includes("secret")
      || normalizedKey.includes("credential")
      || containsCredentialField(nested);
  });
}

export function isCredentialFree(value: unknown): boolean {
  return !containsCredentialField(value);
}

export interface RepositoryDriver {
  createRepository(input: { sourceSpaceId: string }): Promise<AdapterResult<RepositoryHandle>>;
  readSnapshot(input: { repository: RepositoryHandle }): Promise<AdapterResult<{ snapshotId: string }>>;
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
  async createRepository(input: { sourceSpaceId: string }): Promise<AdapterResult<RepositoryHandle>> {
    return { status: "succeeded", value: { repositoryId: opaqueId("repository"), sourceSpaceId: input.sourceSpaceId } };
  }

  async readSnapshot(input: { repository: RepositoryHandle }): Promise<AdapterResult<{ snapshotId: string }>> {
    return { status: "succeeded", value: { snapshotId: `${input.repository.repositoryId}:snapshot` } };
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
        project: { ...input.project, sourceSpaceIds: [...input.project.sourceSpaceIds] },
        sourceSpaces: input.sourceSpaces.map((space) => ({ ...space })),
        projectRevisions: [],
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
