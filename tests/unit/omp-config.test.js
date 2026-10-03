import { describe, expect, it } from "vitest";
import {
  parseConfigYaml,
  buildConfigYaml,
  read9RouterSettings,
  applyModelSettings,
  remove9RouterSettings,
  toSelector,
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