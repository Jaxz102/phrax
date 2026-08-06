import { connect } from "@vercel/connect/eve";
import type { SandboxNetworkPolicy, SandboxSession } from "eve/sandbox";
import type { ToolContext } from "eve/tools";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

export const githubAuth = connect({
  connector: process.env.GITHUB_CONNECTOR ?? "github/phrax",
  principalType: "app",
  tokenParams: {
    scopes: [
      "contents:read",
      "contents:write",
      "metadata:read",
      "pull_requests:read",
      "pull_requests:write",
    ],
  },
  validate: true,
});

export interface Repository {
  owner: string;
  repo: string;
  fullName: string;
}

export interface GitHubRepositoryResponse {
  default_branch: string;
  full_name: string;
}

export interface GitHubPullRequestResponse {
  html_url: string;
  number: number;
  state: string;
}

export function parseRepository(value?: string): Repository {
  const configured = value?.trim() || process.env.PHRAX_DEFAULT_REPOSITORY?.trim();
  if (!configured) {
    throw new Error(
      "No repository was provided and PHRAX_DEFAULT_REPOSITORY is not configured. Ask the user for an owner/repository value.",
    );
  }

  const normalized = configured.replace(/\.git$/u, "");
  if (!repositoryPattern.test(normalized)) {
    throw new Error(
      `Invalid repository ${JSON.stringify(configured)}. Expected owner/repository.`,
    );
  }

  const [owner, repo] = normalized.split("/") as [string, string];
  return { owner, repo, fullName: `${owner}/${repo}` };
}

export function assertBranchName(value: string): string {
  const branch = value.trim();
  const valid =
    branch.startsWith("phrax/") &&
    /^[A-Za-z0-9._/-]+$/u.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("@{") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock");

  if (!valid) {
    throw new Error(
      "Branch names must begin with phrax/ and contain only Git-safe letters, numbers, dots, underscores, hyphens, and slashes.",
    );
  }
  return branch;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export async function getGitHubToken(ctx: ToolContext): Promise<string> {
  const { token } = await ctx.getToken(githubAuth, {
    authKey: "github",
    displayName: "GitHub",
  });
  return token;
}

export function githubNetworkPolicy(token: string): SandboxNetworkPolicy {
  const authenticated = [
    {
      transform: [
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
          },
        },
      ],
    },
  ];

  // The catch-all allows dependency installation and test-time network access.
  // The GitHub credential is injected only for GitHub hosts and never enters
  // the sandbox process or command environment.
  return {
    allow: {
      "github.com": authenticated,
      "codeload.github.com": authenticated,
      "*": [],
    },
  };
}

export async function runCommand(
  sandbox: SandboxSession,
  command: string,
  label: string,
) {
  const result = await sandbox.run({ command });
  if (result.exitCode !== 0) {
    const details = [result.stderr, result.stdout]
      .map((part) => String(part ?? "").trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, 4_000);
    throw new Error(
      `${label} failed with exit code ${result.exitCode}${details ? `:\n${details}` : "."}`,
    );
  }
  return {
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

export async function githubRequest<T>(
  ctx: ToolContext,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Phrax",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: ctx.abortSignal,
  });

  if (response.status === 401) ctx.requireAuth(githubAuth, { authKey: "github" });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 2_000);
    throw new Error(
      `GitHub ${method} ${path} failed with ${response.status}: ${details}`,
    );
  }
  return (await response.json()) as T;
}
