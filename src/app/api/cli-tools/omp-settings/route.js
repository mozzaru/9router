"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { load as loadYaml } from "js-yaml";
import {
  PROVIDER_ID,
  parseConfigYaml,
  buildConfigYaml,
  read9RouterSettings,
  applyModelSettings,
  remove9RouterSettings,
} from "@/lib/ompConfig";

const execAsync = promisify(exec);

const getOmpDir = () => path.join(os.homedir(), ".omp", "agent");
const getOmpDbPath = () => path.join(getOmpDir(), "agent.db");
const getOmpModelsYmlPath = () => path.join(getOmpDir(), "models.yml");
// modelRoles / enabledModels live in config.yml, not models.yml (OMP reads them
// from separate settings layers).
const getOmpConfigYmlPath = () => path.join(getOmpDir(), "config.yml");

const checkOmpInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where omp" : "which omp";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getOmpDbPath());
      return true;
    } catch {
      try {
        await fs.access(getOmpModelsYmlPath());
        return true;
      } catch {
        return false;
      }
    }
  }
};

const readModelsYml = async () => {
  try {
    return await fs.readFile(getOmpModelsYmlPath(), "utf-8");
  } catch {
    return "";
  }
};

const readConfigYml = async () => parseConfigYaml(await readConfigYmlRaw());

const readConfigYmlRaw = async () => {
  try {
    return await fs.readFile(getOmpConfigYmlPath(), "utf-8");
  } catch {
    return null;
  }
};

const writeConfigYml = async (config) => {
  await fs.mkdir(getOmpDir(), { recursive: true });
  await fs.writeFile(getOmpConfigYmlPath(), buildConfigYaml(config), "utf-8");
};

const readProviderBaseUrl = async () => {
  try {
    const parsed = loadYaml(await readModelsYml());
    return parsed?.providers?.[PROVIDER_ID]?.baseUrl || null;
  } catch {
    return null;
  }
};

const has9RouterInYml = (content) => {
  if (!content) return false;
  return content.includes(`${PROVIDER_ID}:`) || content.includes("localhost:20128");
};

// Build standard 9Router provider block for models.yml
const buildOmpProviderYaml = (baseUrl, apiKey) => {
  const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const key = apiKey || "sk_9router";
  return `  ${PROVIDER_ID}:
    baseUrl: ${normalizedBaseUrl}
    apiKey: ${key}
    api: openai-completions
    authHeader: true
    disableStrictTools: true
    discovery:
      type: proxy`;
};

// Match the whole `9router:` provider entry: the header line plus its indented
// body. The body's 4+-space indent is what distinguishes it from a sibling
// provider key at 2 spaces, so a following provider is never swallowed.
const providerBlockRe = () => new RegExp(`^[ \\t]*${PROVIDER_ID}:[^\\n]*\\n(?:[ \\t]{4,}[^\\n]*\\n?)*`, "gm");

export async function GET() {
  try {
    const installed = await checkOmpInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Oh My Pi is not installed",
      });
    }

    const ymlContent = await readModelsYml();
    const has9Router = has9RouterInYml(ymlContent);
    const config = await readConfigYml();
    const { models, activeModel, modelRoles } = read9RouterSettings(config);

    return NextResponse.json({
      installed: true,
      has9Router,
      configPath: getOmpModelsYmlPath(),
      configYmlPath: getOmpConfigYmlPath(),
      modelRoles,
      enabledModels: models,
      omp: {
        models,
        activeModel,
        baseURL: has9Router ? await readProviderBaseUrl() : null,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel, roleModels } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    await fs.mkdir(getOmpDir(), { recursive: true });

    // 1) models.yml — register/replace the 9Router provider block.
    let ymlContent = await readModelsYml();
    const providerBlock = buildOmpProviderYaml(baseUrl, apiKey);
    ymlContent = ymlContent.replace(providerBlockRe(), "");

    if (!ymlContent.trim()) {
      ymlContent = `providers:\n${providerBlock}\n`;
    } else if (ymlContent.includes("providers:")) {
      ymlContent = ymlContent.replace(/providers:/, `providers:\n${providerBlock}`);
    } else {
      ymlContent = `${ymlContent.trim()}\n\nproviders:\n${providerBlock}\n`;
    }

    await fs.writeFile(getOmpModelsYmlPath(), ymlContent, "utf-8");

    // 2) config.yml — enabledModels + modelRoles. Only touched when the caller
    //    actually supplies model settings, so the legacy provider-only setup
    //    (CLI quick-setup) keeps leaving config.yml alone.
    const modelsArray = Array.isArray(models)
      ? models
      : typeof model === "string"
        ? [model]
        : undefined;
    const roleSelections = roleModels && typeof roleModels === "object" ? roleModels : {};
    const hasModelSettings =
      modelsArray !== undefined ||
      typeof activeModel === "string" ||
      typeof subagentModel === "string" ||
      Object.keys(roleSelections).length > 0;

    if (hasModelSettings) {
      const config = applyModelSettings(await readConfigYml(), {
        models: modelsArray,
        activeModel,
        // The card's "Subagent Model" field maps onto OMP's bundled `task`
        // subagent role. Per-agent overrides (task.agentModelOverrides) are a
        // separate setting and are deliberately left untouched.
        subagentModel,
        roleModels: roleSelections,
      });
      await writeConfigYml(config);
    }

    // Best-effort update to agent.db if better-sqlite3 or node:sqlite is present
    try {
      let Database;
      try {
        const mod = await import("better-sqlite3");
        Database = mod.default || mod;
      } catch {
        // fallback ignored
      }
      if (Database) {
        const dbPath = getOmpDbPath();
        const db = new Database(dbPath);
        db.prepare("DELETE FROM auth_credentials WHERE provider = ?").run(PROVIDER_ID);
        db.prepare(
          "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)"
        ).run(
          PROVIDER_ID,
          "api_key",
          JSON.stringify({ apiKey: apiKey || "sk_9router", baseUrl }),
          Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000)
        );
        db.close();
      }
    } catch {
      // Non-critical: models.yml is primary
    }

    return NextResponse.json({
      success: true,
      message: "Oh My Pi settings applied! Run 'omp' and the selected models appear under /model.",
      configPath: getOmpModelsYmlPath(),
      configYmlPath: getOmpConfigYmlPath(),
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    // 1) models.yml — drop the 9Router provider block.
    let ymlContent = await readModelsYml();
    ymlContent = ymlContent.replace(providerBlockRe(), "");

    if (ymlContent.trim() === "providers:") {
      await fs.rm(getOmpModelsYmlPath(), { force: true });
    } else {
      await fs.writeFile(getOmpModelsYmlPath(), ymlContent, "utf-8");
    }

    // 2) config.yml — strip 9Router selectors. Refuse to touch a file we cannot
    //    parse, so a hand-written config.yml is never clobbered.
    const rawConfig = await readConfigYmlRaw();
    if (rawConfig !== null && rawConfig.trim()) {
      const parsed = parseConfigYaml(rawConfig);
      await writeConfigYml(remove9RouterSettings(parsed));
    }

    return NextResponse.json({
      success: true,
      message: "9Router removed from Oh My Pi",
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}