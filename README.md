# Phrax

Phrax is an Eve agent that turns Slack requests into tested GitHub pull
requests. Mention `@Phrax` in Slack, describe a code change, and continue in the
thread if Phrax asks a clarifying question. The repository is edited and tested
inside a per-session Vercel Sandbox. Pushing the branch and opening the PR is a
human-approved action.

## How it works

```text
Slack @mention
      |
      v
durable Eve thread -- unclear --> Slack question --> resume same thread
      |
      v
Vercel Sandbox: clone --> inspect --> edit --> test --> review diff
      |
      v
Slack approval --> push phrax/* branch --> open GitHub PR
```

Kimi K3 runs the agent loop through Moonshot AI's OpenAI-compatible API. Slack
and GitHub credentials are managed by Vercel Connect. The GitHub token is
injected at the Vercel Sandbox firewall for Git traffic and is never written to
the sandbox filesystem or command environment.

## Prerequisites

- Node.js 24
- A Vercel account with Eve, Sandbox, and Connect access
- A Slack workspace where you can install an app
- A GitHub organization or account where you can install a GitHub App
- A Kimi K3 API token

## Configure

1. Install and authenticate the Vercel CLI, then link this directory:

   ```sh
   npm install -g vercel@latest
   vercel login
   vercel link
   ```

2. Create a Slack Connect client with triggers. Record its UID, such as
   `slack/phrax`, and point the trigger at Eve's Slack route:

   ```sh
   vercel connect create slack --triggers
   vercel connect detach slack/phrax --yes
   vercel connect attach slack/phrax --triggers --trigger-path /eve/v1/slack --yes
   ```

   In the connector's Advanced settings, enable these trigger events and bot
   scopes:

   - Events: `app_mention`, `message.im`, `message.channels`
   - Scopes: `app_mentions:read`, `chat:write`, `im:history`,
     `channels:history`

   Add `message.groups` and `groups:history` if Phrax will operate in private
   channels. Install the resulting Slack app in the workspace.

3. Create a GitHub connector from the Vercel Connect dashboard or with
   `vercel connect`. Link it to this Vercel project and install its GitHub App
   on only the repositories Phrax should access. Phrax requests these scopes:

   - Metadata: read
   - Contents: read and write
   - Pull requests: read and write

4. Copy `.env.example` to `.env.local` and fill in `KIMI_API_KEY`. Set the two
   connector UIDs if they differ from `slack/phrax` and `github/phrax`.
   `PHRAX_DEFAULT_REPOSITORY` is optional and uses `owner/repository` format.

   Do not commit `.env.local`; it is ignored by Git.

5. Pull the linked Vercel environment for local Connect authentication:

   ```sh
   vercel env pull
   ```

## Develop

```sh
npm run typecheck
npm run build
npm run dev
```

The interactive Eve development UI uses the same agent definition. Full Slack
webhook testing requires a reachable deployment and installed Connect app.

## Deploy

Add `KIMI_API_KEY`, `KIMI_BASE_URL`, `KIMI_MODEL`, and optional
`PHRAX_DEFAULT_REPOSITORY` to the Vercel project environment. Connector UIDs may
remain at their defaults when those are the UIDs you created. Then deploy:

```sh
VERCEL_USE_EXPERIMENTAL_FRAMEWORKS=1 vercel deploy --prod
```

The Slack trigger destination must be `/eve/v1/slack` on the production
deployment.

## Operational safeguards

- Every GitHub publish requires an explicit Slack approval.
- Phrax creates `phrax/*` branches and never merges PRs.
- GitHub credentials remain outside the execution sandbox.
- Each Slack thread has its own durable session and sandbox workspace.
- Use a fresh Slack thread for a different task or repository.
- Restrict the GitHub App installation to the repositories the bot needs.
- Sandbox egress is open for dependency installation and tests. For sensitive
  repositories, replace the `"*"` rule in `agent/lib/github.ts` with an
  organization-approved domain allowlist.
