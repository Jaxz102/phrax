import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  getGitHubToken,
  githubNetworkPolicy,
  githubRequest,
  parseRepository,
  runCommand,
  shellQuote,
  type GitHubRepositoryResponse,
} from "../lib/github.js";

export default defineTool({
  description:
    "Clone the requested GitHub repository into /workspace/repository in the session sandbox before inspecting or editing code. Omit repository to use PHRAX_DEFAULT_REPOSITORY.",
  inputSchema: z.object({
    repository: z
      .string()
      .describe("GitHub repository in owner/repository form")
      .optional(),
    baseBranch: z
      .string()
      .describe("Base branch to check out; defaults to the repository default")
      .optional(),
  }),
  async execute({ repository: repositoryInput, baseBranch }, ctx) {
    const repository = parseRepository(repositoryInput);
    const token = await getGitHubToken(ctx);
    const metadata = await githubRequest<GitHubRepositoryResponse>(
      ctx,
      token,
      "GET",
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
    );
    const branch = baseBranch?.trim() || metadata.default_branch;
    const sandbox = await ctx.getSandbox();
    await sandbox.setNetworkPolicy(githubNetworkPolicy(token));

    const workspace = sandbox.resolvePath("repository");
    const probe = await sandbox.run({
      command: `test -d ${shellQuote(`${workspace}/.git`)}`,
    });

    if (probe.exitCode !== 0) {
      const directoryProbe = await sandbox.run({
        command: `test ! -e ${shellQuote(workspace)} || test -z "$(ls -A ${shellQuote(workspace)} 2>/dev/null)"`,
      });
      if (directoryProbe.exitCode !== 0) {
        throw new Error(
          `${workspace} already exists and is not an empty Git repository. Start a fresh Slack thread for a different task.`,
        );
      }

      await runCommand(
        sandbox,
        [
          "GIT_TERMINAL_PROMPT=0 git clone",
          "--depth 50",
          `--branch ${shellQuote(branch)}`,
          shellQuote(`https://github.com/${repository.fullName}.git`),
          shellQuote(workspace),
        ].join(" "),
        `Clone ${repository.fullName}`,
      );
    } else {
      const remote = await runCommand(
        sandbox,
        `cd ${shellQuote(workspace)} && git remote get-url origin`,
        "Read the existing repository remote",
      );
      const expectedRemote = `https://github.com/${repository.fullName}.git`;
      if (remote.stdout.trim() !== expectedRemote) {
        throw new Error(
          `This Slack thread already contains ${remote.stdout.trim()}, not ${expectedRemote}. Start a fresh thread for a different repository.`,
        );
      }
    }

    const head = await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && git rev-parse HEAD`,
      "Read repository HEAD",
    );
    const status = await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && git status --short`,
      "Read repository status",
    );

    return {
      repository: repository.fullName,
      defaultBranch: metadata.default_branch,
      requestedBaseBranch: branch,
      workingDirectory: workspace,
      headSha: head.stdout.trim(),
      status: status.stdout.trim() || "clean",
    };
  },
});
