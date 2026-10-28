import { AI_PROVIDERS, getProviderByAlias, isOpenAICompatibleProvider, isAnthropicCompatibleProvider } from "@/shared/constants/providers";

// Removing a provider from the registry (v0.5.321 dropped the webCookie
// providers: deepseek-web, gemini-web, kimi-web, muse-web, chatgpt-web,
// uc-web, opencode-v2) left its providerConnections rows behind. Those rows
// are unreachable - no executor, no alias, no model list - but every consumer
// that walks the connection table still pays for them: `/api/providers` lists
// them as editable, and the basic-chat page requests
// `/api/providers/{id}/models` for each one, which answers
// `400 Provider deepseek-web does not support models listing` and logs a
// console error on every load.
//
// A provider id is only removed here when it is provably gone: not in
// AI_PROVIDERS, not a known alias, and not one of the dynamic compatible
// families whose ids carry a uuid (openai-compatible-chat-*, or
// anthropic-compatible-*). Anything else is left untouched, so a row for a
// provider this build cannot see is kept rather than guessed at.
export default {
  version: 5,
  name: "drop connections for removed providers",
  up(db) {
    let rows = [];
    try {
      rows = db.all("SELECT id, provider FROM providerConnections");
    } catch {
      return; // table absent on a very old database; 001 creates it.
    }

    const doomed = [];
    for (const row of rows) {
      const provider = String(row?.provider || "");
      if (!provider) continue;
      if (isOpenAICompatibleProvider(provider) || isAnthropicCompatibleProvider(provider)) continue;
      if (AI_PROVIDERS[provider] || getProviderByAlias(provider)) continue;
      doomed.push({ id: row.id, provider });
    }

    for (const row of doomed) {
      try {
        db.run("DELETE FROM providerConnections WHERE id = ?", [row.id]);
      } catch {}
    }

    if (doomed.length) {
      const names = [...new Set(doomed.map((d) => d.provider))].join(", ");
      console.log(`[migrate] removed ${doomed.length} connection(s) for providers no longer in the registry: ${names}`);
    }
  },
};
