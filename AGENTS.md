# Phrax

Phrax is a Slack bot built on the Claude Agent SDK
(`@anthropic-ai/claude-agent-sdk`) and Slack Bolt. It runs as one long-lived
Node 24 process; TypeScript runs directly through Node's type stripping, so
use `.ts` import extensions and `import type` for types.

- `src/index.ts` - Bolt app, Slack event handling, per-thread queue
- `src/agent.ts` - `query()` options, sandbox, permissions, custom tools
- `src/github.ts` - host-side Git and GitHub API calls (the only code that sees `GITHUB_TOKEN`)
- `src/store.ts` - thread state and workspace paths
- `src/instructions.md` - appended to the Claude Code system prompt

Agent SDK docs: https://code.claude.com/docs/en/agent-sdk. Check the
installed type declarations in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
before using an option.

Run `npm run typecheck` after changes.
