import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SQLiteCohortLandingAuthority, type CohortLandingReview } from "../../src/cloudflare/cohort-landing.ts";
import type { AuthoritySession } from "../../src/cloudflare/authority-plane.ts";
import type { LandingAuthority } from "../../src/change-control/collaboration.ts";
import { cohortStore } from "./cohort-sqlite.ts";

const [databasePath, inputPath, crashAt] = process.argv.slice(2);
if (!databasePath || !inputPath || !crashAt) throw new Error("fixture_arguments_required");
const input = JSON.parse(readFileSync(inputPath, "utf8")) as { projectId: string; session: AuthoritySession; request: Parameters<LandingAuthority["landCohort"]>[0]; review: CohortLandingReview };
const database = new DatabaseSync(databasePath);
const store = cohortStore(database, (collection) => {
  // Abrupt termination deliberately bypasses transactionSync's JS rollback.
  if (collection === crashAt) process.exit(73);
});
new SQLiteCohortLandingAuthority({ store, session: input.session, projectId: input.projectId, evaluate: () => input.review }).landCohort(input.request);
if (crashAt === "after-commit") process.exit(74); // success response lost
database.close();
