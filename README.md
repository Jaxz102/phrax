# Phrax

Phrax works on GitHub repositories from Slack. Mention `@Phrax` in Slack,
describe a code change or question, and keep replying in the thread if Phrax
asks a question. Phrax picks the relevant repositories (several when a question
spans, say, a frontend and the backend), clones them, edits and tests in a sandbox,
and replies with a summary. It never pushes or opens pull requests.

It is one Node process built on the
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and
[Slack Bolt](https://docs.slack.dev/tools/bolt-js/).

## How it works

```text
Slack @mention ──> Bolt (/slack/events) ──> Agent SDK query()  (resumed per thread)
                                               │
                         prepare_repository ───┤  host clones each repo into ./<name> in the thread workspace
                                               │
               sandboxed Bash / Read / Edit ───┘  inspect, edit, test, reply in the thread
```

- **One session per Slack thread.** The thread's Agent SDK session ID is saved
  in `~/.phrax/state.json`, and each new message resumes it.
- **Sandboxed commands.** The agent's Bash tool runs in the Agent SDK sandbox
  (Seatbelt on macOS, bubblewrap on Linux). It can write only to the thread
  workspace and reach only the package-registry hosts in `src/agent.ts`.
  File tools outside the workspace are denied.
- **The GitHub token stays on the host.** The agent's environment is replaced
  with a short allowlist, so `GITHUB_TOKEN` and the Slack secrets never reach
  it. Cloning and the GitHub API run in `src/github.ts`.
- **Repository settings aren't loaded.** `settingSources: []` keeps a cloned
  repository's `.claude/settings.json` hooks from running. The agent reads
  `AGENTS.md` and `CLAUDE.md` as ordinary files.

## Prerequisites

- Node.js 24
- macOS, or Linux with `bubblewrap` and `socat` installed (for the sandbox)
- An Anthropic API key
- A Slack workspace where you can install an app
- A GitHub fine-grained personal access token

## Configure

1. **GitHub token.** Create a
   [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
   with access to only the repositories Phrax should work on, and these
   permissions:
   - Contents: read
   - Metadata: read (added automatically)

2. **Slack app.** At <https://api.slack.com/apps>:
   - Turn **Socket Mode** off.
   - **OAuth & Permissions**: add the bot scopes `app_mentions:read`,
     `chat:write`, `im:history`, and `channels:history` (add
     `groups:history` for private channels). Install the app and copy the
     `xoxb-...` bot token.
   - **Basic Information**: copy the Signing Secret.
   - **Event Subscriptions**: enable events, set the Request URL to
     `https://<public-host>/slack/events`, and subscribe to the bot events
     `app_mention`, `message.im`, and `message.channels` (and
     `message.groups` for private channels).

3. **Environment.** Copy `.env.example` to `.env` and fill in
   `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and
   `GITHUB_TOKEN`. `.env` is ignored by Git.

## Develop

```sh
npm install
npm run typecheck
npm run dev          # restarts on file changes
```

Slack needs a public URL to reach your machine. In a second terminal, run
ngrok against the same port:

```sh
ngrok http --url=<your-static-domain>.ngrok-free.app 3000
```

Or run both at once with `make start` (`make dev` restarts on file changes).
It uses `NGROK_URL` from `.env` if set, prints the Slack Request URL, and
stops both processes on Ctrl-C.

Use a separate Slack app for development so production keeps its Request URL.

## Deploy

Run `npm start` as a long-lived process on a host with a public HTTPS URL,
such as a VM, Fly.io, Railway, or Render. Serverless functions are not a good
fit because a turn can run for many minutes. Keep `PHRAX_DATA_DIR` on a
persistent disk: it holds the thread workspaces and session state. Agent SDK
session transcripts live in `~/.claude/projects/`, so persist that too.

## Operational notes

- Configure repositories with `<NAME>_REPOSITORY=owner/repository` in `.env`
  (for example `BACKEND_REPOSITORY`). The name becomes the clone directory and
  what users can call it in Slack. Restart Phrax after changing them.
- A thread keeps its clones, so follow-ups can reuse them or add another
  repository. Use a fresh Slack thread for an unrelated task.
- Thread workspaces are not cleaned up automatically. Delete old directories
  under `~/.phrax/threads/` when you no longer need them.
- Set `PHRAX_MAX_BUDGET_USD` to cap spend per turn.
- To let sandboxed commands reach more hosts (a private registry, for
  example), add them to `PHRAX_ALLOWED_DOMAINS`.
