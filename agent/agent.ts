import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";

const kimi = createOpenAICompatible({
  name: "kimi",
  apiKey: process.env.KIMI_API_KEY,
  baseURL: process.env.KIMI_BASE_URL ?? "https://api.moonshot.ai/v1",
  includeUsage: true,
});

export default defineAgent({
  model: kimi(process.env.KIMI_MODEL ?? "kimi-k3"),
  modelContextWindowTokens: 1_048_576,
  compaction: {
    thresholdPercent: 0.8,
  },
  limits: {
    maxInputTokensPerSession: 2_000_000,
    maxOutputTokensPerSession: 200_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
  build: {
    externalDependencies: ["@vercel/connect"],
  },
});
