import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required. Set it in .env.`);
  return value;
}

function optional(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

/** Directory that holds this app's source and its .env file. */
export const appRoot = resolve(import.meta.dirname, "..");

const dataDir = resolve(optional("PHRAX_DATA_DIR") ?? join(homedir(), ".phrax"));
const fromAppRoot = relative(appRoot, dataDir);
if (!fromAppRoot.startsWith("..")) {
  // The sandbox denies reads of appRoot (it holds .env), so workspaces must
  // live outside it.
  throw new Error(`PHRAX_DATA_DIR (${dataDir}) must be outside ${appRoot}.`);
}

/**
 * Named repositories from `<NAME>_REPOSITORY` variables, e.g.
 * BACKEND_REPOSITORY=acme/api becomes { backend: "acme/api" }. PHRAX_* and
 * GITHUB_* variables are skipped (GITHUB_REPOSITORY is set by GitHub Actions).
 */
function namedRepositories(): Record<string, string> {
  const repositories: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    const match = /^([A-Z0-9_]+)_REPOSITORY$/u.exec(key);
    if (!match || key.startsWith("PHRAX_") || key.startsWith("GITHUB_") || !value?.trim()) continue;
    repositories[match[1]!.toLowerCase().replaceAll("_", "-")] = value.trim();
  }
  return repositories;
}

export const config = {
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  model: optional("ANTHROPIC_MODEL") ?? "claude-sonnet-5",
  maxBudgetUsd: optional("PHRAX_MAX_BUDGET_USD")
    ? Number(optional("PHRAX_MAX_BUDGET_USD"))
    : undefined,

  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackSigningSecret: required("SLACK_SIGNING_SECRET"),
  port: Number(optional("PORT") ?? 3000),

  githubToken: required("GITHUB_TOKEN"),
  defaultRepository: optional("PHRAX_DEFAULT_REPOSITORY"),
  repositories: namedRepositories(),

  dataDir,
  /** Extra domains the sandboxed Bash tool may reach, comma-separated. */
  extraAllowedDomains: (optional("PHRAX_ALLOWED_DOMAINS") ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean),
};
