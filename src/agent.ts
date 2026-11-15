import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createSdkMcpServer,
  query,
  tool,
  type CanUseTool,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { appRoot, config } from "./config.ts";
import { cloneRepository, getDefaultBranch, normalizeFullName, resolveRepository, type Repository } from "./github.ts";
import { saveThread, threadPaths, type ThreadState } from "./store.ts";

function repositoryInstructions() {
  const named = Object.entries(config.repositories);
  const lines = ["## Repositories"];
  if (named.length) {
    lines.push(
      "These repositories are configured. Pass the name to `prepare_repository`:",
      "",
      ...named.map(([name, fullName]) => `- \`${name}\`: ${fullName}`),
    );
  }
  if (config.defaultRepository) {
    lines.push("", `The default repository is ${config.defaultRepository}.`);
  }
  if (!named.length && !config.defaultRepository) {
    lines.push("No repositories are configured. If the user does not name one, ask for it in owner/repository form.");
  }
  return lines.join("\n");
}

const instructions = [
  readFileSync(join(import.meta.dirname, "instructions.md"), "utf8").trimEnd(),
  repositoryInstructions(),
].join("\n\n");
const PREPARE_TOOL = "mcp__phrax__prepare_repository";

/** Package hosts the sandboxed Bash tool may reach for installs and tests. */
const defaultAllowedDomains = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "proxy.golang.org",
  "sum.golang.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "rubygems.org",
  "repo.maven.apache.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

export interface Turn {
  key: string;
  thread: ThreadState;
  text: string;
  onProgress: (status: string) => void;
}

/** Configured repositories use their name (./backend); others use the repository name. */
function directoryFor(repository: Repository) {
  const target = repository.fullName.toLowerCase();
  const named = Object.entries(config.repositories).find(
    ([, fullName]) => normalizeFullName(fullName).toLowerCase() === target,
  );
  return named?.[0] ?? repository.repo;
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function describeToolUse(name: string, input: Record<string, unknown>): string {
  const field = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash":
      return field("description") || field("command").slice(0, 80);
    case "Read":
    case "Edit":
    case "Write":
      return `${name} ${field("file_path").split("/").slice(-2).join("/")}`;
    case PREPARE_TOOL:
      return `Cloning ${field("repository") || "the repository"}`;
    default:
      return name;
  }
}

/** Runs one Slack message through the agent and returns its final reply. */
export async function runTurn(turn: Turn): Promise<string> {
  const { key, thread } = turn;
  const paths = threadPaths(key);
  await Promise.all([paths.workspace, paths.tmp, paths.cache].map((dir) => mkdir(dir, { recursive: true })));

  const phrax = createSdkMcpServer({
    name: "phrax",
    version: "1.0.0",
    tools: [
      tool(
        "prepare_repository",
        "Clone a GitHub repository into a subdirectory of the working directory. Call it once per repository you need, before inspecting it. Returns the subdirectory.",
        {
          repository: z
            .string()
            .describe("A configured repository name, or owner/repository. Omit to use the default.")
            .optional(),
          baseBranch: z.string().describe("Branch to start from; defaults to the repository default").optional(),
        },
        async (args) => {
          const repository = resolveRepository(args.repository);
          const cloned = (thread.repositories ??= {});
          const existing = cloned[repository.fullName];
          if (existing) {
            return text(
              `${repository.fullName} is already cloned in ./${existing.directory} (base branch ${existing.baseBranch}).`,
            );
          }
          const directory = directoryFor(repository);
          if (Object.values(cloned).some((entry) => entry.directory === directory)) {
            throw new Error(`./${directory} already holds another repository in this thread.`);
          }
          const baseBranch = args.baseBranch?.trim() || (await getDefaultBranch(repository));
          const head = await cloneRepository(repository, baseBranch, paths, directory);
          cloned[repository.fullName] = { directory, baseBranch };
          await saveThread(key, thread);
          return text(`Cloned ${repository.fullName} at ${baseBranch} (${head}) into ./${directory}.`);
        },
      ),
    ],
  });

  // Called for any tool use the permission rules don't already allow.
  const canUseTool: CanUseTool = async (toolName, input) => {
    if (toolName === PREPARE_TOOL) return { behavior: "allow", updatedInput: input };
    return {
      behavior: "deny",
      message: `${toolName} is not allowed here. You can only work inside your working directory.`,
    };
  };

  const home = homedir();
  const messages = query({
    prompt: turn.text,
    options: {
      model: config.model,
      effort: "high",
      cwd: paths.workspace,
      resume: thread.sessionId,
      systemPrompt: { type: "preset", preset: "claude_code", append: instructions },
      // Don't load settings, hooks, or CLAUDE.md from the host or the cloned
      // repository: repository settings could run hooks outside the sandbox.
      settingSources: [],
      tools: ["Bash", "Read", "Edit", "Write", "Glob", "Grep", "TodoWrite"],
      mcpServers: { phrax },
      // File edits inside the working directory are accepted and sandboxed
      // Bash runs freely; every other tool use goes to canUseTool.
      permissionMode: "acceptEdits",
      canUseTool,
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [...defaultAllowedDomains, ...config.extraAllowedDomains] },
        filesystem: {
          allowWrite: [paths.tmp, paths.cache],
          denyRead: [
            appRoot,
            join(config.dataDir, "state.json"),
            join(home, ".ssh"),
            join(home, ".aws"),
            join(home, ".config"),
            join(home, ".claude"),
            join(home, ".netrc"),
            join(home, ".npmrc"),
            join(home, ".gitconfig"),
          ],
        },
        credentials: { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }] },
      },
      // Replace the inherited environment so the GitHub and Slack tokens never
      // reach the agent or its commands.
      env: {
        PATH: process.env.PATH,
        HOME: home,
        LANG: process.env.LANG ?? "en_US.UTF-8",
        ANTHROPIC_API_KEY: config.anthropicApiKey,
        CLAUDE_AGENT_SDK_CLIENT_APP: "phrax/0.1.0",
        TMPDIR: paths.tmp,
        XDG_CACHE_HOME: paths.cache,
        npm_config_cache: join(paths.cache, "npm"),
        GIT_TERMINAL_PROMPT: "0",
      },
      maxTurns: 200,
      ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
    },
  });

  let reply = "";
  for await (const message of messages as AsyncIterable<SDKMessage>) {
    if (message.session_id && message.session_id !== thread.sessionId) {
      thread.sessionId = message.session_id;
      await saveThread(key, thread);
    }
    if (message.type === "assistant" && !message.parent_tool_use_id) {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          turn.onProgress(describeToolUse(block.name, block.input as Record<string, unknown>));
        }
      }
    }
    if (message.type === "result") {
      reply =
        message.subtype === "success"
          ? message.result
          : `I stopped before finishing (${message.subtype.replaceAll("_", " ")}). Reply in this thread to continue.`;
    }
  }
  return reply.trim() || "I finished without producing a reply.";
}
