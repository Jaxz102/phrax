import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  assertBranchName,
  getGitHubToken,
  githubNetworkPolicy,
  githubRequest,
  parseRepository,
  runCommand,
  shellQuote,
  type GitHubPullRequestResponse,
  type GitHubRepositoryResponse,
} from "../lib/github.js";

export default defineTool({
  description:
    "After implementation and tests are complete, commit the sandbox changes, push a phrax/* branch, and open a GitHub pull request. Always requires human approval before execution.",
  inputSchema: z.object({
    repository: z.string().describe("GitHub owner/repository").optional(),
    baseBranch: z.string().describe("PR base branch").optional(),
    branchName: z
      .string()
      .describe("New branch name beginning with phrax/"),
    commitMessage: z.string().min(1).max(200),
    title: z.string().min(1).max(256),
    body: z
      .string()
      .min(1)
      .describe("PR description with Summary and Testing sections"),
  }),
  approval: always(),
  async execute(input, ctx) {
    const repository = parseRepository(input.repository);
    const branchName = assertBranchName(input.branchName);
    const token = await getGitHubToken(ctx);
    const metadata = await githubRequest<GitHubRepositoryResponse>(
      ctx,
      token,
      "GET",
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`,
    );
    const baseBranch = input.baseBranch?.trim() || metadata.default_branch;
    if (branchName === baseBranch) {
      throw new Error("The PR branch must differ from its base branch.");
    }

    const sandbox = await ctx.getSandbox();
    await sandbox.setNetworkPolicy(githubNetworkPolicy(token));
    const workspace = sandbox.resolvePath("repository");

    const remote = await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && git remote get-url origin`,
      "Read repository remote",
    );
    const expectedRemote = `https://github.com/${repository.fullName}.git`;
    if (remote.stdout.trim() !== expectedRemote) {
      throw new Error(
        `Sandbox remote ${remote.stdout.trim()} does not match ${expectedRemote}.`,
      );
    }

    await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && git checkout -B ${shellQuote(branchName)}`,
      `Create branch ${branchName}`,
    );
    await runCommand(
      sandbox,
      [
        `cd ${shellQuote(workspace)}`,
        `git config user.name ${shellQuote("Phrax")}`,
        `git config user.email ${shellQuote("phrax[bot]@users.noreply.github.com")}`,
        "git add -A",
      ].join(" && "),
      "Stage changes",
    );

    const staged = await sandbox.run({
      command: `cd ${shellQuote(workspace)} && git diff --cached --quiet`,
    });
    if (staged.exitCode === 1) {
      await runCommand(
        sandbox,
        `cd ${shellQuote(workspace)} && git commit -m ${shellQuote(input.commitMessage)}`,
        "Commit changes",
      );
    } else if (staged.exitCode !== 0) {
      throw new Error("Unable to determine whether the repository has staged changes.");
    }

    const ahead = await sandbox.run({
      command: `cd ${shellQuote(workspace)} && git rev-list --count ${shellQuote(`origin/${baseBranch}`)}..HEAD`,
    });
    if (ahead.exitCode !== 0 || Number.parseInt(String(ahead.stdout), 10) < 1) {
      throw new Error("There are no committed changes to open as a pull request.");
    }

    await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && GIT_TERMINAL_PROMPT=0 git push --set-upstream origin HEAD:${shellQuote(`refs/heads/${branchName}`)}`,
      `Push branch ${branchName}`,
    );

    const query = new URLSearchParams({
      state: "open",
      head: `${repository.owner}:${branchName}`,
      base: baseBranch,
      per_page: "1",
    });
    const existing = await githubRequest<GitHubPullRequestResponse[]>(
      ctx,
      token,
      "GET",
      `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls?${query.toString()}`,
    );

    const pullRequest =
      existing[0] ??
      (await githubRequest<GitHubPullRequestResponse>(
        ctx,
        token,
        "POST",
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/pulls`,
        {
          title: input.title,
          body: input.body,
          head: branchName,
          base: baseBranch,
          draft: false,
        },
      ));

    const head = await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && git rev-parse HEAD`,
      "Read pushed commit",
    );
    const diff = await runCommand(
      sandbox,
      `cd ${shellQuote(workspace)} && git diff --stat ${shellQuote(`origin/${baseBranch}`)}...HEAD`,
      "Summarize pull request diff",
    );

    return {
      repository: repository.fullName,
      number: pullRequest.number,
      url: pullRequest.html_url,
      branch: branchName,
      baseBranch,
      commitSha: head.stdout.trim(),
      diffSummary: diff.stdout.trim(),
      reusedExistingPullRequest: existing.length > 0,
    };
  },
});
