import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CONTRACT_VERSIONS,
  createProject,
  createProjectRevision,
  deriveProjectView,
  ProjectViewProjectionError,
  type ProjectInput,
  type SourceSpace,
} from "../kernel/contracts.ts";
import { createPublicProjection, type PublicProjectionSource } from "../disclosure/hybrid.ts";

export type ReferenceFixtureId = "worker" | "typescript-library" | "hybrid-source";

export type ReferenceFixture = {
  id: ReferenceFixtureId;
  project: ProjectInput;
  sourceSpaces: readonly SourceSpace[];
  expectedFiles: readonly string[];
  journeys: readonly ValidationJourney[];
};

export type ValidationStep =
  | { kind: "file-exists"; path: string }
  | { kind: "file-contains"; path: string; text: string }
  | { kind: "public-projection-excludes"; sourceSpaceId: string }
  | { kind: "module-call"; path: string; exportName: string; args: readonly ModuleCallArgument[]; expected: unknown };

export type ModuleCallArgument = unknown | { type: "request"; url: string };

export type ValidationJourney = {
  id: string;
  description: string;
  steps: readonly ValidationStep[];
};

const sourceSpace = (id: string, name: string, classification: SourceSpace["classification"]): SourceSpace => ({
  protocol: CONTRACT_VERSIONS.sourceSpace,
  id,
  name,
  classification,
});

export const referenceFixtures: readonly ReferenceFixture[] = [
  {
    id: "worker",
    project: {
      id: "project:worker",
      name: "Anyam Worker Reference",
      referenceType: "cloudflare-worker",
      sourceSpaceIds: ["worker-source"],
    },
    sourceSpaces: [sourceSpace("worker-source", "worker-source", "public")],
    expectedFiles: ["worker/src/index.ts", "worker/wrangler.jsonc", "worker/README.md", "worker/anyam.json"],
    journeys: [
      {
        id: "scaffold",
        description: "The Worker fixture has the source and project configuration needed to start.",
        steps: [
          { kind: "file-exists", path: "worker/src/index.ts" },
          { kind: "file-contains", path: "worker/src/index.ts", text: "handle" },
          { kind: "file-exists", path: "worker/wrangler.jsonc" },
        ],
      },
      {
        id: "local-check",
        description: "The Worker fixture declares a local check entry point.",
        steps: [
          { kind: "file-contains", path: "worker/README.md", text: "source contract" },
          {
            kind: "module-call",
            path: "worker/src/index.ts",
            exportName: "handle",
            args: [{ type: "request", url: "https://fixture.test/demo" }],
            expected: JSON.stringify({ fixture: "worker", path: "/demo" }),
          },
        ],
      },
      {
        id: "release",
        description: "The Worker fixture identifies a release artifact.",
        steps: [{ kind: "file-contains", path: "worker/README.md", text: "Release" }],
      },
      {
        id: "promotion",
        description: "The Worker fixture identifies its Cloudflare target.",
        steps: [{ kind: "file-contains", path: "worker/wrangler.jsonc", text: "name" }],
      },
      {
        id: "rollback",
        description: "The Worker fixture documents a recoverable deployment path.",
        steps: [{ kind: "file-contains", path: "worker/README.md", text: "rollback" }],
      },
    ],
  },
  {
    id: "typescript-library",
    project: {
      id: "project:typescript-library",
      name: "Anyam TypeScript Library Reference",
      referenceType: "typescript-library",
      sourceSpaceIds: ["typescript-library-source"],
    },
    sourceSpaces: [sourceSpace("typescript-library-source", "typescript-library-source", "public")],
    expectedFiles: ["typescript-library/src/index.ts", "typescript-library/package.json", "typescript-library/README.md", "typescript-library/anyam.json"],
    journeys: [
      {
        id: "scaffold",
        description: "The library fixture has package metadata and a source entry point.",
        steps: [
          { kind: "file-exists", path: "typescript-library/src/index.ts" },
          { kind: "file-exists", path: "typescript-library/package.json" },
        ],
      },
      {
        id: "local-check",
        description: "The library fixture exposes a typed public function.",
        steps: [
          { kind: "file-contains", path: "typescript-library/src/index.ts", text: "greet" },
          {
            kind: "module-call",
            path: "typescript-library/src/index.ts",
            exportName: "greet",
            args: ["Anyam"],
            expected: "Hello, Anyam",
          },
        ],
      },
      {
        id: "typed-artifact",
        description: "The library fixture declares a TypeScript package.",
        steps: [{ kind: "file-contains", path: "typescript-library/src/index.ts", text: "export function" }],
      },
      {
        id: "release-asset",
        description: "The library fixture declares a package name for release output.",
        steps: [{ kind: "file-contains", path: "typescript-library/package.json", text: "name" }],
      },
    ],
  },
  {
    id: "hybrid-source",
    project: {
      id: "project:hybrid-video-player",
      name: "Anyam Hybrid Video Player Reference",
      referenceType: "hybrid-public-private",
      sourceSpaceIds: ["public-player", "private-codec"],
    },
    sourceSpaces: [
      sourceSpace("public-player", "public-player", "public"),
      sourceSpace("private-codec", "private-codec", "restricted"),
    ],
    expectedFiles: [
      "hybrid/public-player/src/index.ts",
      "hybrid/private-codec/src/codec.ts",
      "hybrid/README.md",
    ],
    journeys: [
      {
        id: "public-projection",
        description: "The public Project View omits the private codec Source Space.",
        steps: [{ kind: "public-projection-excludes", sourceSpaceId: "private-codec" }],
      },
      {
        id: "private-disclosure",
        description: "The private codec remains source-controlled without being part of the public View.",
        steps: [
          { kind: "file-exists", path: "hybrid/private-codec/src/codec.ts" },
          { kind: "file-contains", path: "hybrid/private-codec/src/codec.ts", text: "private" },
        ],
      },
      {
        id: "sealed-verification",
        description: "The hybrid fixture records the result-only verification boundary.",
        steps: [{ kind: "file-contains", path: "hybrid/README.md", text: "Source Spaces" }],
      },
      {
        id: "publication-change",
        description: "The hybrid fixture records that public projection is an explicit operation.",
        steps: [{ kind: "file-contains", path: "hybrid/README.md", text: "public" }],
      },
    ],
  },
];

export type FixtureValidationResult = {
  ok: boolean;
  checkedFiles: number;
  missingFiles: readonly string[];
  missingJourneys: readonly string[];
  failedJourneys: readonly string[];
  checkedJourneys: number;
};

export async function validateReferenceFixtures(root: string): Promise<FixtureValidationResult> {
  const missingFiles: string[] = [];
  const missingJourneys: string[] = [];
  const failedJourneys: string[] = [];
  let checkedFiles = 0;
  let checkedJourneys = 0;

  for (const fixture of referenceFixtures) {
    for (const relativePath of fixture.expectedFiles) {
      checkedFiles += 1;
      const filePath = join(root, relativePath);
      if (!existsSync(filePath) || !statSync(filePath).isFile() || readFileSync(filePath, "utf8").trim().length === 0) {
        missingFiles.push(`${fixture.id}:${relativePath}`);
      }
    }
    if (fixture.journeys.length === 0) {
      missingJourneys.push(fixture.id);
      continue;
    }

    for (const journey of fixture.journeys) {
      checkedJourneys += 1;
      if (journey.steps.length === 0) {
        failedJourneys.push(`${fixture.id}:${journey.id}:no-steps`);
        continue;
      }
      for (const step of journey.steps) {
        if (step.kind === "file-exists" || step.kind === "file-contains") {
          const filePath = join(root, step.path);
          if (!existsSync(filePath) || !statSync(filePath).isFile()) {
            failedJourneys.push(`${fixture.id}:${journey.id}:${step.path}`);
          } else if (step.kind === "file-contains" && !readFileSync(filePath, "utf8").includes(step.text)) {
            failedJourneys.push(`${fixture.id}:${journey.id}:${step.path}:missing-text`);
          }
        } else if (step.kind === "public-projection-excludes") {
          const project = createProject(fixture.project);
          const revision = createProjectRevision({
            projectId: project.id,
            sourceSpaceSnapshots: Object.fromEntries(
              fixture.sourceSpaces.map((space) => [space.id, `fixture:${space.id}`]),
            ),
          });
          try {
            const view = deriveProjectView({
              project,
              revision,
              sourceSpaces: fixture.sourceSpaces,
              allowedSourceSpaceIds: fixture.sourceSpaces
                .filter((space) => space.id !== step.sourceSpaceId && space.classification === "public")
                .map((space) => space.id),
              projectionId: `${fixture.id}:public`,
              classification: "public",
            });
            if (view.visibleSourceSpaceIds.includes(step.sourceSpaceId)) {
              failedJourneys.push(`${fixture.id}:${journey.id}:disclosed:${step.sourceSpaceId}`);
            }
            if (fixture.id === "hybrid-source") {
              const sources: PublicProjectionSource[] = fixture.sourceSpaces.map((space) => {
                const prefix = `hybrid/${space.id}/`;
                const files = Object.fromEntries(
                  fixture.expectedFiles
                    .filter((expectedPath) => expectedPath.startsWith(prefix))
                    .map((expectedPath) => [expectedPath.slice(prefix.length), readFileSync(join(root, expectedPath), "utf8")]),
                );
                return {
                  sourceSpaceId: space.id,
                  snapshotId: `fixture:${space.id}`,
                  files,
                };
              });
              const publicProjection = createPublicProjection({
                project,
                canonicalRevision: revision,
                sourceSpaces: fixture.sourceSpaces,
                publicSourceSpaceIds: fixture.sourceSpaces
                  .filter((space) => space.classification === "public")
                  .map((space) => space.id),
                sources,
              });
              const serializedProjection = JSON.stringify(publicProjection);
              if (serializedProjection.includes(step.sourceSpaceId) || serializedProjection.includes("private-codec")) {
                failedJourneys.push(`${fixture.id}:${journey.id}:private-metadata-disclosed`);
              }
              if (serializedProjection.includes(revision.id)) {
                failedJourneys.push(`${fixture.id}:${journey.id}:canonical-revision-disclosed`);
              }
            }
          } catch (error) {
            const code = error instanceof ProjectViewProjectionError ? error.code : "unknown-projection-error";
            failedJourneys.push(`${fixture.id}:${journey.id}:projection-error:${code}`);
          }
        } else {
          const filePath = join(root, step.path);
          try {
            const moduleUrl = `${pathToFileURL(filePath).href}?fixture=${fixture.id}-${journey.id}`;
            const module = await import(moduleUrl) as Record<string, unknown>;
            const exported = module[step.exportName];
            if (typeof exported !== "function") {
              failedJourneys.push(`${fixture.id}:${journey.id}:missing-export:${step.exportName}`);
              continue;
            }
            const args = step.args.map((argument) => {
              if (typeof argument === "object" && argument !== null && "type" in argument && argument.type === "request") {
                return new Request((argument as { type: "request"; url: string }).url);
              }
              return argument;
            });
            const actual = await exported(...args);
            const normalizedActual = actual instanceof Response ? await actual.text() : actual;
            if (JSON.stringify(normalizedActual) !== JSON.stringify(step.expected)) {
              failedJourneys.push(`${fixture.id}:${journey.id}:unexpected-output:${step.exportName}`);
            }
          } catch {
            failedJourneys.push(`${fixture.id}:${journey.id}:module-error:${step.exportName}`);
          }
        }
      }
    }
  }

  return {
    ok: missingFiles.length === 0 && missingJourneys.length === 0 && failedJourneys.length === 0,
    checkedFiles,
    missingFiles,
    missingJourneys,
    failedJourneys,
    checkedJourneys,
  };
}
