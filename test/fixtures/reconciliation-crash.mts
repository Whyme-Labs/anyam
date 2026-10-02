import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CanonicalRefReconciler, type CanonicalRefBinding } from "../../src/cloudflare/canonical-ref-reconciliation.ts";
import { cohortStore } from "./cohort-sqlite.ts";
import { FencedGitProviderFixture } from "./fenced-git-provider.ts";
import { projectId, session } from "./reconciliation-project.ts";

const [path, inputPath, crashAt] = process.argv.slice(2);
if (!path || !inputPath || !crashAt) throw new Error("crash_arguments_required");
const input = JSON.parse(readFileSync(inputPath, "utf8")) as { providerRoot: string; bindings: CanonicalRefBinding[]; directories: Record<string, string> };
const database = new DatabaseSync(path);
const store = cohortStore(database, (collection, payload) => {
  if (crashAt === "completion-row" && collection === "canonicalRefProjections" && typeof payload === "string" && JSON.parse(payload).state === "complete") process.exit(86);
});
const provider = new FencedGitProviderFixture(input.providerRoot, input.directories, (operation) => {
  if (crashAt === `after-${operation}`) process.exit(85);
});
await new CanonicalRefReconciler({ store, session, projectId, bindings: input.bindings, provider }).reconcile();
if (crashAt === "after-complete") process.exit(87);
database.close();
