// Pure transforms for Oh My Pi's 9Router wiring.
//
// OMP reads provider/model config from `models.yml` and selection settings from
// `config.yml`. Selection written into `config.yml` is fragile: OMP owns that
// file, and a provider reset can replace it wholesale. So the selection is kept
// in `models.yml` too — this module writes it there by default and can mirror
// it into `config.yml` on demand.
//
// The API key is never written literally: `models.yml` stores an env var name,
// which OMP resolves as environment-variable-name-or-literal.


import { load as loadYaml, dump as dumpYaml } from "js-yaml";

export const PROVIDER_ID = "9router";
export const SELECTOR_PREFIX = `${PROVIDER_ID}/`;
// Name written into `models.yml`'s `apiKey`. OMP substitutes the variable's
// value when it exists and falls back to the literal string when it does not,
// so a shell export keeps the real key out of every file we touch.
export const API_KEY_ENV = "NINEROUTER_API_KEY";

// `apiKey` value for a provider block. OMP resolves this field as
// environment-variable-name-or-literal, so the bare name is what selects the
// exported variable — a `$` prefix would be sent as a literal key instead.
export const apiKeyRef = () => API_KEY_ENV;

// Model values reach the API without the `9router/` prefix (the raw ids the
// picker and /v1 use). Normalize to a full `provider/modelId` selector.
export const toSelector = (value) => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.startsWith(SELECTOR_PREFIX) ? trimmed : `${SELECTOR_PREFIX}${trimmed}`;
};

// Inverse of toSelector: null for selectors owned by another provider.
export const stripSelectorPrefix = (value) =>
  typeof value === "string" && value.startsWith(SELECTOR_PREFIX)
    ? value.slice(SELECTOR_PREFIX.length)
    : null;

// `enabledModels` may hold plain selectors or path-scoped `{ path, models }`
// objects. Only plain strings scoped to 9Router belong to us.
export const is9RouterEntry = (entry) =>
  typeof entry === "string" && entry.startsWith(SELECTOR_PREFIX);

// Parse config.yml defensively: a malformed or non-mapping file yields {} so the
// dashboard card degrades to "not configured" instead of a 500.
export const parseConfigYaml = (text) => {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const parsed = loadYaml(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

export const buildConfigYaml = (config) =>
  dumpYaml(config, { noRefs: true, lineWidth: -1 });

// The 9Router-scoped view of the current config: which 9Router models the user
// enabled, the active (default) model, and every role pointing at 9Router.
export const read9RouterSettings = (config) => {
  const enabledModels = Array.isArray(config?.enabledModels) ? config.enabledModels : [];
  const roles = config?.modelRoles && typeof config.modelRoles === "object" ? config.modelRoles : {};

  const modelRoles = {};
  for (const [role, value] of Object.entries(roles)) {
    const raw = stripSelectorPrefix(value);
    if (raw) modelRoles[role] = raw;
  }

  return {
    models: enabledModels.map(stripSelectorPrefix).filter(Boolean),
    activeModel: stripSelectorPrefix(roles.default),
    modelRoles,
  };
};

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Apply selection settings in place. Only keys the caller actually supplied are
// touched, so a provider-only apply (CLI quick setup) never rewrites config.yml.
//
// `{ models }`        — replaces `enabledModels` with these 9Router selectors.
// `{ activeModel }`   — sets/clears `modelRoles.default`.
// `{ subagentModel }` — sets/clears `modelRoles.task` (the bundled `task`
//                       subagent role; per-agent overrides are separate).
// `{ roleModels }`    — arbitrary extra role assignments, e.g. { smol, plan }.
export const applyModelSettings = (config, { models, activeModel, subagentModel, roleModels } = {}) => {
  const next = isPlainObject(config) ? { ...config } : {};
  const roles = isPlainObject(next.modelRoles) ? { ...next.modelRoles } : {};

  if (models !== undefined && models !== null) {
    const selectors = [...new Set((models || []).map(toSelector).filter(Boolean))];
    // `enabledModels` is a global scope: entries belonging to other providers
    // (including path-scoped `{ path, models }` objects) must survive an apply.
    const existing = Array.isArray(next.enabledModels) ? next.enabledModels : [];
    const others = existing.filter((entry) => !is9RouterEntry(entry));
    const firstRouterIndex = existing.findIndex(is9RouterEntry);
    if (selectors.length === 0) {
      if (others.length > 0) next.enabledModels = others;
      else delete next.enabledModels;
    } else if (firstRouterIndex === -1) {
      next.enabledModels = [...others, ...selectors];
    } else {
      next.enabledModels = [...others.slice(0, firstRouterIndex), ...selectors, ...others.slice(firstRouterIndex)];
    }

    // The supplied list is authoritative for 9Router: a role still pointing at a
    // model that is no longer enabled would be dangling, so drop those roles.
    // Roles assigned explicitly in this call are re-applied below.
    const enabled = new Set(selectors);
    for (const [role, value] of Object.entries(roles)) {
      if (is9RouterEntry(value) && !enabled.has(value)) delete roles[role];
    }
  }

  const assignments = { ...(isPlainObject(roleModels) ? roleModels : {}) };
  if (typeof subagentModel === "string" && !("task" in assignments)) {
    assignments.task = subagentModel;
  }
  if (typeof activeModel === "string") assignments.default = activeModel;

  for (const [role, value] of Object.entries(assignments)) {
    const selector = toSelector(value);
    if (selector) {
      roles[role] = selector;
    } else if (typeof roles[role] === "string" && roles[role].startsWith(SELECTOR_PREFIX)) {
      // Cleared 9Router role: drop it so it falls back to its own chain.
      delete roles[role];
    }
  }

  if (Object.keys(roles).length > 0) next.modelRoles = roles;
  else delete next.modelRoles;

  return next;
};

// Strip every 9Router selector from config.yml; other providers are untouched.
export const remove9RouterSettings = (config) => {
  if (!isPlainObject(config)) return {};
  const next = { ...config };

  if (Array.isArray(next.enabledModels)) {
    const remaining = next.enabledModels
      .filter((entry) => !is9RouterEntry(entry))
      .map((entry) => {
        if (!isPlainObject(entry)) return entry;
        const listKey = Array.isArray(entry.models) ? "models" : Array.isArray(entry.values) ? "values" : null;
        if (!listKey) return entry;
        const kept = entry[listKey].filter((value) => !is9RouterEntry(value));
        return kept.length > 0 ? { ...entry, [listKey]: kept } : null;
      })
      .filter((entry) => entry !== null);
    if (remaining.length > 0) next.enabledModels = remaining;
    else delete next.enabledModels;
  }

  if (isPlainObject(next.modelRoles)) {
    const roles = { ...next.modelRoles };
    for (const [role, value] of Object.entries(roles)) {
      if (typeof value === "string" && value.startsWith(SELECTOR_PREFIX)) delete roles[role];
    }
    if (Object.keys(roles).length > 0) next.modelRoles = roles;
    else delete next.modelRoles;
  }

  return next;
};

// ── models.yml ──────────────────────────────────────────────────────────────
// 9Router's /v1/models fans out to every active provider's live catalogue, so it
// routinely answers in 10-15s. OMP probes proxy discovery with a 10s budget by
// default — the endpoint always exceeded it, discovery returned no models at
// all, and only hand-written `models:` entries were ever visible. The budget is
// raised past the observed latency so every 9Router model gets discovered.
export const DISCOVERY_TIMEOUT_MS = 60000;

// Plain YAML scalars are safe for the ids 9Router publishes (slugs with dots,
// dashes, slashes). Anything else is quoted so a stray colon, `#`, or leading
// `-` can never truncate the document.
const yamlScalar = (value) =>
  /^[A-Za-z0-9_][A-Za-z0-9._/@+-]*$/.test(value) ? value : JSON.stringify(value);

// Keys the block template owns. Anything else on a hand-written provider entry
// (`reasoning: true`, a proxy override, ...) is carried across an apply instead
// of being silently dropped, which would change how the provider behaves.
const OWNED_PROVIDER_KEYS = new Set([
  "baseUrl", "apiKey", "api", "authHeader", "disableStrictTools", "discovery", "models",
]);

export const providerExtras = (entry) =>
  Object.fromEntries(
    Object.entries(entry && typeof entry === "object" ? entry : {})
      .filter(([key, value]) => !OWNED_PROVIDER_KEYS.has(key) && ["string", "number", "boolean"].includes(typeof value))
  );

// Provider entry written into models.yml. Pinned models are ids only: OMP merges
// explicit entries with whatever discovery returns instead of replacing it, and
// they stay usable when the server is unreachable. The pinned list IS the
// operator's pick, so no selection has to live in config.yml.
export const buildProviderBlock = (baseUrl, apiKey, models = [], extras = {}) => {
  const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const lines = [
    `  ${PROVIDER_ID}:`,
    `    baseUrl: ${normalizedBaseUrl}`,
    `    apiKey: ${yamlScalar(apiKey || apiKeyRef())}`,
    "    api: openai-completions",
    "    authHeader: true",
    "    disableStrictTools: true",
    "    discovery:",
    "      type: proxy",
    `      timeoutMs: ${DISCOVERY_TIMEOUT_MS}`,
  ];
  for (const [key, value] of Object.entries(providerExtras(extras))) {
    lines.push(`    ${key}: ${yamlScalar(String(value))}`);
  }
  const ids = [...new Set(
    (Array.isArray(models) ? models : [])
      .map((model) => (typeof model === "string" ? model.trim() : ""))
      .filter(Boolean)
  )];
  if (ids.length > 0) {
    lines.push("    models:");
    for (const id of ids) lines.push(`      - id: ${yamlScalar(id)}`);
  }
  return lines.join("\n");
};

// Model ids pinned in models.yml. The dashboard card falls back to this list so
// a hand-written (or previously applied) entry set still drives its selection.
export const readProviderModelIds = (yamlText) => {
  if (typeof yamlText !== "string" || !yamlText.trim()) return [];
  try {
    const models = loadYaml(yamlText)?.providers?.[PROVIDER_ID]?.models;
    if (!Array.isArray(models)) return [];
    return models
      .map((entry) => (typeof entry === "string" ? entry : entry?.id))
      .filter((id) => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
};