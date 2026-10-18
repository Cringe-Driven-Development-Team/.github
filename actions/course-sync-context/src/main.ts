import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createGitHubApi, type GitHubApi } from "./api.js";
import { InputError, parseCandidate } from "./policy.js";
import { systemClock, type Clock, verifyCandidate } from "./verify.js";

export async function executeAction(
  env: NodeJS.ProcessEnv,
  api: GitHubApi,
  clock: Clock,
  writeOutput: (line: string) => void,
): Promise<void> {
  if (!env.GH_TOKEN) throw new InputError("GH_TOKEN: missing token");
  if (!env.GITHUB_OUTPUT) throw new InputError("GITHUB_OUTPUT: missing output file");
  const candidate = parseCandidate({
    sourceRepo: env.SOURCE_REPO ?? "",
    runId: env.CI_RUN_ID ?? "",
    sha: env.SHA ?? "",
  });
  const target = await verifyCandidate(candidate, api, clock);
  writeOutput(`target=${target}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = process.env;
  executeAction(env, createGitHubApi(env.GH_TOKEN ?? ""), systemClock,
    line => appendFileSync(env.GITHUB_OUTPUT!, line, "utf8"))
    .catch(error => {
      const detail = error instanceof Error ? error.message : "unexpected error";
      console.error(`Course sync refused: ${detail}`);
      process.exitCode = 1;
    });
}
