import { App } from "@slack/bolt";

import { runTurn } from "./agent.ts";
import { config } from "./config.ts";
import { getThread, loadThreads, saveThread, threadKey, type ThreadState } from "./store.ts";

const app = new App({
  token: config.slackBotToken,
  signingSecret: config.slackSigningSecret,
});

const handledEvents = new Set<string>();
const threadQueues = new Map<string, Promise<void>>();

/** Slack retries slow deliveries; handle each event once. */
function firstDelivery(eventId: string) {
  if (handledEvents.has(eventId)) return false;
  handledEvents.add(eventId);
  if (handledEvents.size > 1_000) handledEvents.delete(handledEvents.values().next().value!);
  return true;
}

/** Runs turns for one thread in order, so a follow-up waits for the current turn. */
function enqueue(key: string, task: () => Promise<void>) {
  const previous = threadQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  threadQueues.set(key, current);
  void current.finally(() => {
    if (threadQueues.get(key) === current) threadQueues.delete(key);
  });
}

interface Inbound {
  eventId: string;
  teamId: string;
  channel: string;
  threadTs: string;
  text: string;
}

function handle(inbound: Inbound) {
  if (!firstDelivery(inbound.eventId)) return;
  const key = threadKey(inbound.teamId, inbound.channel, inbound.threadTs);

  enqueue(key, async () => {
    const thread: ThreadState = getThread(key) ?? {
      channel: inbound.channel,
      threadTs: inbound.threadTs,
    };
    await saveThread(key, thread);

    const status = await app.client.chat.postMessage({
      channel: inbound.channel,
      thread_ts: inbound.threadTs,
      text: "Working…",
    });

    let lastUpdate = 0;
    const onProgress = (detail: string) => {
      const now = Date.now();
      if (!status.ts || now - lastUpdate < 3_000) return;
      lastUpdate = now;
      void app.client.chat
        .update({ channel: inbound.channel, ts: status.ts, text: `Working… ${detail}` })
        .catch((error) => app.logger.warn(error));
    };

    let reply: string;
    try {
      reply = await runTurn({ key, thread, text: inbound.text, onProgress });
    } catch (error) {
      app.logger.error(error);
      reply = "Something went wrong while I was working on this. Check the Phrax logs.";
    }

    if (status.ts) await app.client.chat.delete({ channel: inbound.channel, ts: status.ts }).catch(() => undefined);
    await app.client.chat.postMessage({
      channel: inbound.channel,
      thread_ts: inbound.threadTs,
      text: reply.slice(0, 3_000),
      blocks: [{ type: "markdown", text: reply.slice(0, 12_000) }],
    });
  });
}

let botUserId = "";

app.event("app_mention", async ({ event, body }) => {
  if (!event.user || event.bot_id || event.subtype) return;
  const text = event.text.replaceAll(`<@${botUserId}>`, "").trim();
  if (!text) return;
  handle({
    eventId: body.event_id,
    teamId: body.team_id,
    channel: event.channel,
    threadTs: event.thread_ts ?? event.ts,
    text,
  });
});

app.message(async ({ message, body }) => {
  if (message.subtype !== undefined || message.bot_id || !message.text?.trim()) return;
  // Mentions arrive as app_mention events too.
  if (message.text.includes(`<@${botUserId}>`)) return;

  const threadTs = message.thread_ts ?? message.ts;
  const isDirectMessage = message.channel_type === "im";
  const continuesThread = Boolean(getThread(threadKey(body.team_id, message.channel, threadTs)));
  if (!isDirectMessage && !continuesThread) return;

  handle({
    eventId: body.event_id,
    teamId: body.team_id,
    channel: message.channel,
    threadTs,
    text: message.text.trim(),
  });
});

app.error(async (error) => {
  app.logger.error(error);
});

await loadThreads();
botUserId = (await app.client.auth.test()).user_id ?? "";
await app.start(config.port);
app.logger.info(`Phrax is listening on port ${config.port} at /slack/events`);
