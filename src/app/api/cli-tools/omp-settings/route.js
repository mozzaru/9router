
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
  buildProviderBlock,
  providerExtras,
  readProviderModelIds,
  API_KEY_ENV,
  apiKeyRef,
} from "@/lib/ompConfig";

export const dynamic = "force-dynamic";

const execAsync = promisify(exec);

const getOmpDir = () => path.join(os.homedir(), ".omp", "agent");
const getOmpDbPath = () => path.join(getOmpDir(), "agent.db");
const getOmpModelsYmlPath = () => path.join(getOmpDir(), "models.yml");
// modelRoles / enabledModels are read from config.yml (OMP's settings layer) —
// `models.yml` only defines providers and model metadata. The picked ids are
// still written into `models.yml` too, so a config.yml reset loses nothing.
const getOmpConfigYmlPath = () => path.join(getOmpDir(), "config.yml");

// An env var name OMP resolves against the environment; anything else is a
// literal key. Keys look like `sk-...`, which never matches this shape.
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

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

// Provider entry currently on disk, parsed. Used only to carry hand-written keys
// (`reasoning`, proxy overrides) across a rewrite.
const readProviderEntry = async (content) => {
  try {
    const text = typeof content === "string" ? content : await readModelsYml();
    return loadYaml(text)?.providers?.[PROVIDER_ID] || null;
  } catch {
    return null;
  }
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
    const { models: enabledModels, activeModel, modelRoles } = read9RouterSettings(config);
    // config.yml holds the applied selection; models.yml holds the same ids as
    // the pinned list. Fall back to it so a hand-written provider block still
    // shows up as the card's selection instead of silently reading as "none".
    const pinnedModels = readProviderModelIds(ymlContent);
    const models = enabledModels.length > 0 ? enabledModels : pinnedModels;
    // The provider block stores a name, not a value, when the operator keeps the
    // key in the shell. Report the mode so the card can show it back.
    const storedKey = (await readProviderEntry(ymlContent))?.apiKey;
    const apiKeyEnv = typeof storedKey === "string" && ENV_NAME_RE.test(storedKey) ? storedKey : null;

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
        apiKeyEnv,
        defaultApiKeyEnv: API_KEY_ENV,
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
    const { baseUrl, apiKey, apiKeyEnv, apiKeyLiteral, model, models, activeModel, subagentModel, roleModels } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    // The key is written by name, not by value: OMP resolves `apiKey` as
    // environment-variable-name-or-literal, so the secret lives in the shell
    // (~/.bashrc) and never in a file we write. `apiKeyLiteral: true` keeps the
    // old behaviour for callers that cannot export one.
    const envName = typeof apiKeyEnv === "string" ? apiKeyEnv.trim() : "";
    if (envName && !ENV_NAME_RE.test(envName)) {
      return NextResponse.json({ error: { message: "apiKeyEnv must be a valid environment variable name" } }, { status: 400 });
    }
    const useEnvKey = !apiKeyLiteral;
    const keyValue = useEnvKey ? (envName || apiKeyRef()) : apiKey;

    await fs.mkdir(getOmpDir(), { recursive: true });

    // 1) models.yml — register/replace the 9Router provider block. A selection
    //    sent by the caller replaces the pinned list; an apply without one (CLI
    //    quick setup) keeps whatever is already pinned.
    let ymlContent = await readModelsYml();
    const modelsArray = Array.isArray(models)
      ? models
      : typeof model === "string"
        ? [model]
        : undefined;
    const pinnedModels = modelsArray !== undefined ? modelsArray : readProviderModelIds(ymlContent);
    const existingEntry = await readProviderEntry();
    const providerBlock = buildProviderBlock(baseUrl, keyValue, pinnedModels, providerExtras(existingEntry));
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

    // Best-effort update to agent.db. In env-key mode the row is only removed:
    // storing the key here would defeat the point of referencing an environment
    // variable, and a stale literal row would outrank the shell export.
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
        if (!useEnvKey) {
          db.prepare(
            "INSERT INTO auth_credentials (provider, credential_type, data, disabled_cause, identity_key, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)"
          ).run(
            PROVIDER_ID,
            "api_key",
            JSON.stringify({ apiKey: apiKey || "sk_9router", baseUrl }),
            Math.floor(Date.now() / 1000),
            Math.floor(Date.now() / 1000)
          );
        }
        db.close();
      }
    } catch {
      // Non-critical: models.yml is primary
    }

    return NextResponse.json({
      success: true,
      // OMP keeps the provider roster in models.db for two hours, so a model
      // added here does not appear in a running omp until its cache expires or
      // the operator forces a re-probe. Say so instead of promising otherwise.
      message: "Oh My Pi settings applied! Run 'omp models refresh' so the selected models appear under /model.",
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