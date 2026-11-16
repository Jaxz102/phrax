import { execFile } from "node:child_process";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { config } from "./config.ts";
import type { ThreadPaths } from "./store.ts";

const execFileAsync = promisify(execFile);
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const gitTimeoutMs = 5 * 60_000;

export interface Repository {
  owner: string;
  repo: string;
  fullName: string;
}

/** Normalizes a configured name (e.g. "Mobile App" -> "mobile-app"). */
function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/gu, "-");
}

/** Strips a github.com URL prefix, trailing slash, and .git suffix. */
export function normalizeFullName(value: string) {
  return value.trim().replace(/^https:\/\/github\.com\//u, "").replace(/\/$/u, "").replace(/\.git$/u, "");
}

/**
 * Resolves a configured name such as "backend", or an owner/repository
 * string. With no value, falls back to PHRAX_DEFAULT_REPOSITORY.
 */
export function resolveRepository(value?: string): Repository {
  const requested = value?.trim();
  const named = requested ? config.repositories[normalizeName(requested)] : undefined;
  const configured = named ?? (requested || config.defaultRepository);
  if (!configured) {
    throw new Error("No repository was provided and PHRAX_DEFAULT_REPOSITORY is not set. Ask the user which repository to use.");
  }
  const normalized = normalizeFullName(configured);
  if (!repositoryPattern.test(normalized)) {
    const names = Object.keys(config.repositories);
    throw new Error(
      `Invalid repository ${JSON.stringify(configured)}. Expected owner/repository` +
        (names.length ? ` or one of: ${names.join(", ")}.` : "."),
    );
  }
  const [owner, repo] = normalized.split("/") as [string, string];
  if ([owner, repo].some((part) => /^\.+$/u.test(part))) {
    throw new Error(`Invalid repository ${JSON.stringify(configured)}.`);
  }
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function remoteUrl(repository: Repository) {
  return `https://github.com/${repository.fullName}.git`;
}

/**
 * Runs Git on the host. The token is passed through GIT_CONFIG_* environment
 * variables, so it is never written to a repository config or shown in argv.
 * Global and system Git config are ignored so host settings cannot interfere.
 */
async function git(args: string[], options: { cwd?: string; authenticated?: boolean } = {}) {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  if (options.authenticated) {
    const basic = Buffer.from(`x-access-token:${config.githubToken}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: gitTimeoutMs,
    });
    return stdout.trim();
  } catch (error) {
    const failure = error as { stderr?: string; message: string; killed?: boolean };
    if (failure.killed) throw new Error(`git ${args[0]} timed out after ${gitTimeoutMs / 60_000} minutes.`);
    const details = (failure.stderr || failure.message).trim().slice(0, 2_000);
    throw new Error(`git ${args[0]} failed: ${details}`);
  }
}

async function githubRequest<T>(method: "GET", path: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.githubToken}`,
      "User-Agent": "Phrax",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const details = (await response.text()).slice(0, 2_000);
    throw new Error(`GitHub ${method} ${path} failed with ${response.status}: ${details}`);
  }
  return (await response.json()) as T;
}

function repoPath(repository: Repository) {
  return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
}

export async function getDefaultBranch(repository: Repository) {
  const metadata = await githubRequest<{ default_branch: string }>("GET", repoPath(repository));
  return metadata.default_branch;
}

/**
 * Shallow-clones the latest commit (no history) into a host-only staging
 * directory, configures it there, then moves it into the workspace. Git never
 * runs from the host inside a directory the agent could have touched, and
 * rename fails rather than following anything the agent placed at the target
 * path.
 */
export async function cloneRepository(repository: Repository, baseBranch: string, paths: ThreadPaths, directory: string) {
  const staged = join(paths.staging, directory);
  const target = join(paths.workspace, directory);
  await rm(staged, { recursive: true, force: true });
  await mkdir(paths.staging, { recursive: true });
  await git(["clone", "--depth", "1", "--branch", baseBranch, "--single-branch", remoteUrl(repository), staged], {
    authenticated: true,
  });
  // No credentials are stored, so the workspace cannot reach GitHub with the token.
  await git(["config", "user.name", "Phrax"], { cwd: staged });
  await git(["config", "user.email", "phrax[bot]@users.noreply.github.com"], { cwd: staged });
  const head = await git(["rev-parse", "HEAD"], { cwd: staged });
  try {
    await rename(staged, target);
  } catch (error) {
    await rm(staged, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
      throw new Error(`${directory} already exists in the working directory. Move or delete it, then try again.`);
    }
    throw error;
  }
  return head;
}
