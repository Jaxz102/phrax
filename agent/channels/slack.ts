import { connectSlackCredentials } from "@vercel/connect/eve";
import {
  defaultSlackAuth,
  slackChannel,
  type SlackInboundMessageContext,
  type SlackMessage,
} from "eve/channels/slack";

async function dispatch(
  ctx: SlackInboundMessageContext,
  message: SlackMessage,
) {
  if (!message.author || message.author.isBot) return null;
  await ctx.thread.startTyping("Thinking…");
  return { auth: defaultSlackAuth(message, ctx) };
}

export default slackChannel({
  botName: "Phrax",
  credentials: connectSlackCredentials(
    process.env.SLACK_CONNECTOR ?? "slack/phrax",
  ),
  threadContext: { since: "last-agent-reply" },
  onAppMention: dispatch,
  onDirectMessage: dispatch,
  async onMessage(ctx, message) {
    if (!message.author || message.author.isBot) return null;
    if (!(await ctx.isSubscribed())) return null;
    return dispatch(ctx, message);
  },
});
