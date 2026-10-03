// Pure transforms for Oh My Pi's 9Router wiring.
//
// OMP keeps provider/model metadata in `models.yml` (see omp-settings route) but
// reads *selection* settings — `enabledModels`, `modelRoles`, `cycleOrder` —
// from `config.yml`. These helpers own the config.yml side so the route only
// does filesystem I/O and the merge semantics stay unit-testable.

import { load as loadYaml, dump as dumpYaml } from "js-yaml";

export const PROVIDER_ID = "9router";
export const SELECTOR_PREFIX = `${PROVIDER_ID}/`;

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