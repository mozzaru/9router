import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";
import {
  parseConfigYaml,
  buildConfigYaml,
  read9RouterSettings,
  applyModelSettings,
  remove9RouterSettings,
  toSelector,
  buildProviderBlock,
  providerExtras,
  readProviderModelIds,
  DISCOVERY_TIMEOUT_MS,
  API_KEY_ENV,
  apiKeyRef,
} from "@/lib/ompConfig.js";

const OTHER_CONFIG = `setupVersion: 2
enabledModels:
  - sky/some-other-model
  - 9router/old-model
modelRoles:
  flat: sky/other
  default: 9router/old-model
  smol: 9router/old-smol
`;

// The block is emitted pre-indented for insertion under `providers:`; wrap it
// the way the route does so the assertions read the parsed document.
const providerEntry = (block) => loadYaml(`providers:\n${block}\n`).providers["9router"];

describe("omp config.yml merge semantics", () => {
  it("normalizes bare ids to 9router selectors", () => {
    expect(toSelector("tokenharbor-deepseek-v4.1")).toBe("9router/tokenharbor-deepseek-v4.1");
    expect(toSelector("9router/x")).toBe("9router/x");
    expect(toSelector("  ")).toBeNull();
    expect(toSelector(null)).toBeNull();
  });

  it("writes multi-model enabledModels plus active and subagent roles", () => {
    const next = applyModelSettings(parseConfigYaml(""), {
      models: ["m1", "9router/m2", "m1"],
      activeModel: "m2",
      subagentModel: "m3",
    });

    expect(next.enabledModels).toEqual(["9router/m1", "9router/m2"]);
    expect(next.modelRoles).toEqual({ default: "9router/m2", task: "9router/m3" });
  });

  it("preserves other providers' models and roles across an apply", () => {
    const next = applyModelSettings(parseConfigYaml(OTHER_CONFIG), {
      models: ["new-router-model"],
      activeModel: "new-router-model",
    });

    // The unrelated provider entry must survive; only 9Router entries are replaced.
    expect(next.enabledModels).toContain("sky/some-other-model");
    expect(next.enabledModels).toContain("9router/new-router-model");
    expect(next.enabledModels).not.toContain("9router/old-model");
    expect(next.modelRoles.flat).toBe("sky/other");
    expect(next.modelRoles.default).toBe("9router/new-router-model");
    expect(next.modelRoles.smol).toBeUndefined();
    expect(next.setupVersion).toBe(2);
  });

  it("keeps an unrelated path-scoped enabledModels entry intact", () => {
    const withScope = `enabledModels:\n  - 9router/old\n  - path: ~/work\n    models:\n      - anthropic/opus\n`;
    const next = applyModelSettings(parseConfigYaml(withScope), { models: ["fresh"] });

    const scoped = next.enabledModels.find((e) => typeof e === "object");
    expect(scoped).toEqual({ path: "~/work", models: ["anthropic/opus"] });
    expect(next.enabledModels).toContain("9router/fresh");
  });

  it("clears the named 9Router role but leaves other roles alone", () => {
    const next = applyModelSettings(parseConfigYaml(OTHER_CONFIG), { activeModel: "" });

    expect(next.modelRoles.default).toBeUndefined();
    expect(next.modelRoles.flat).toBe("sky/other");
    // Clearing `default` must not disturb an unrelated 9Router role.
    expect(next.modelRoles.smol).toBe("9router/old-smol");
  });

  it("touches nothing when no model settings are supplied", () => {
    expect(applyModelSettings(parseConfigYaml(OTHER_CONFIG), {})).toEqual(parseConfigYaml(OTHER_CONFIG));
  });

  it("reports the 9Router-scoped view", () => {
    const view = read9RouterSettings(parseConfigYaml(OTHER_CONFIG));
    expect(view.models).toEqual(["old-model"]);
    expect(view.activeModel).toBe("old-model");
    expect(view.modelRoles).toEqual({ default: "old-model", smol: "old-smol" });
  });

  it("degrades malformed YAML to an empty object", () => {
    expect(parseConfigYaml("{{{ nope")).toEqual({});
    expect(parseConfigYaml("")).toEqual({});
    expect(parseConfigYaml("- just\n- a\n- list")).toEqual({});
  });

  it("removes only 9Router selectors and can round-trip through YAML", () => {
    const next = remove9RouterSettings(parseConfigYaml(OTHER_CONFIG));
    expect(next.enabledModels).toEqual(["sky/some-other-model"]);
    expect(next.modelRoles).toEqual({ flat: "sky/other" });
    expect(parseConfigYaml(buildConfigYaml(next))).toEqual(next);
  });
});

describe("omp models.yml provider block", () => {
  it("raises the discovery probe budget past 9Router's model-list latency", () => {
    const block = buildProviderBlock("http://127.0.0.1:20128", "sk_9router");
    const provider = providerEntry(block);
    // The observed /v1/models latency is 10-15s; OMP's 10s default timed out and
    // discovery published no models at all.
    expect(provider.discovery).toEqual({ type: "proxy", timeoutMs: DISCOVERY_TIMEOUT_MS });
    expect(DISCOVERY_TIMEOUT_MS).toBeGreaterThan(15000);
    expect(provider.models).toBeUndefined();
  });

  it("pins the selection without duplicating ids", () => {
    const block = buildProviderBlock("http://127.0.0.1:20128/v1", "sk_9router", ["m1", "m2", "m1", "  ", null]);
    const provider = providerEntry(block);
    expect(provider.models).toEqual([{ id: "m1" }, { id: "m2" }]);
    expect(provider.baseUrl).toBe("http://127.0.0.1:20128/v1");
    expect(readProviderModelIds(`providers:\n${block}\n`)).toEqual(["m1", "m2"]);
  });

  it("quotes ids that a plain scalar would truncate", () => {
    const block = buildProviderBlock("http://host", "sk-9router", ["weird: id", "has #hash"]);
    expect(providerEntry(block).models).toEqual([{ id: "weird: id" }, { id: "has #hash" }]);
  });

  it("reads ids back from either a block or a hand-written list", () => {
    expect(readProviderModelIds(`providers:\n  9router:\n    models:\n      - plain-id\n`)).toEqual(["plain-id"]);
    expect(readProviderModelIds("providers:\n  other:\n    x: 1\n")).toEqual([]);
    expect(readProviderModelIds("{{{ nope")).toEqual([]);
  });

  it("carries hand-written provider keys across a rewrite", () => {
    const existing = {
      baseUrl: "http://old/v1",
      apiKey: "old",
      reasoning: true,
      discovery: { type: "proxy" },
      models: [{ id: "old" }],
    };
    const provider = providerEntry(buildProviderBlock("http://new", "k", ["fresh"], providerExtras(existing)));
    // Template-owned keys are rewritten; anything hand-written survives.
    expect(provider.baseUrl).toBe("http://new/v1");
    expect(provider.apiKey).toBe("k");
    expect(provider.reasoning).toBe(true);
    expect(provider.models).toEqual([{ id: "fresh" }]);
  });
});

describe("omp apiKey as an environment reference", () => {
  it("writes the variable name, never a literal secret", () => {
    expect(apiKeyRef()).toBe(API_KEY_ENV);
    const block = buildProviderBlock("http://127.0.0.1:20128", apiKeyRef(), ["m1"]);
    expect(block).toContain(`apiKey: ${API_KEY_ENV}`);
    expect(providerEntry(block).apiKey).toBe(API_KEY_ENV);
    // OMP resolves this field as env-name-or-literal, so the bare name is the
    // reference; a `$` prefix would be sent to the server as the key itself.
    expect(block).not.toContain("apiKey: $");
  });

  it("still writes an explicit key when the caller insists", () => {
    const block = buildProviderBlock("http://127.0.0.1:20128", "sk-literal-1", []);
    expect(providerEntry(block).apiKey).toBe("sk-literal-1");
  });
});