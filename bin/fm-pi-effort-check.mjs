#!/usr/bin/env node
// Resolve the selected model through Pi's own runtime and check its native
// thinking-level set. This is deliberately read-only: credentials are loaded
// into memory, model catalogs are not refreshed over the network, and no
// session is created or modified.
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const [selectedExecutable, fallbackExecutable, modelArgument, effort, cwdArgument, agentDirArgument, providerArgument, sessionRef, approveArgument] = process.argv.slice(2);
const allowedEfforts = new Set(["xhigh", "max"]);

function refuse(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

if (process.argv.length !== 11 || !selectedExecutable || !cwdArgument || !allowedEfforts.has(effort)) {
  refuse("invalid Pi effort capability check arguments");
}

const cwd = resolve(cwdArgument);
const agentDir = resolve(agentDirArgument || process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";

function packageRootFrom(candidate) {
  if (!candidate) return undefined;
  let current;
  try {
    current = dirname(realpathSync(candidate));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < 9; depth += 1) {
    const packageFile = join(current, "package.json");
    try {
      const info = JSON.parse(readFileSync(packageFile, "utf8"));
      if (info.name === "@earendil-works/pi-coding-agent" && existsSync(join(current, "dist", "index.js"))) {
        return { root: current, version: info.version };
      }
    } catch {
      // Keep walking only through the selected executable's own ancestors.
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function commandVersion(executable) {
  const output = execFileSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 3000,
    env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  return output.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/)?.[0];
}

const candidates = [];
if (process.env.PI_PACKAGE_DIR) candidates.push({ root: resolve(process.env.PI_PACKAGE_DIR), source: process.env.PI_PACKAGE_DIR });
for (const candidate of [selectedExecutable, fallbackExecutable]) {
  const found = packageRootFrom(candidate);
  if (found && !candidates.some((entry) => entry.root === found.root)) candidates.push({ ...found, source: candidate });
}
let selected;
let selectedVersion;
try {
  selectedVersion = commandVersion(selectedExecutable);
} catch {
  refuse(`could not query the selected Pi executable version at ${selectedExecutable}`);
}
for (const candidate of candidates) {
  let info = candidate;
  if (!info.version) {
    try {
      const packageJson = JSON.parse(readFileSync(join(info.root, "package.json"), "utf8"));
      info = { ...info, version: packageJson.version };
    } catch {
      continue;
    }
  }
  if (info.version === selectedVersion) {
    selected = info;
    break;
  }
}
if (!selected) {
  refuse(`cannot locate the exact Pi SDK used by ${selectedExecutable}; expose its @earendil-works/pi-coding-agent package through PI_PACKAGE_DIR`);
}

const packageRoot = selected.root;
let pi;
let piAi;
try {
  pi = await import(pathToFileURL(join(packageRoot, "dist", "index.js")).href);
  piAi = await import(pathToFileURL(join(packageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")).href);
} catch (error) {
  refuse(`the selected Pi SDK does not expose its native model runtime: ${error instanceof Error ? error.message : String(error)}`);
}

const requiredPiExports = ["ModelRuntime", "SettingsManager", "SessionManager", "resolveCliModel", "resolveModelScopeWithDiagnostics", "ProjectTrustStore", "hasTrustRequiringProjectResources"];
const missingExports = requiredPiExports.filter((name) => typeof pi[name] === "undefined");
if (missingExports.length > 0 || typeof piAi.getSupportedThinkingLevels !== "function" || typeof piAi.InMemoryModelsStore !== "function" || typeof piAi.InMemoryCredentialStore !== "function" || typeof piAi.modelsAreEqual !== "function") {
  refuse(`the selected Pi SDK lacks native effort capability APIs (${[...missingExports, ...(typeof piAi.getSupportedThinkingLevels !== "function" ? ["getSupportedThinkingLevels"] : []), ...(typeof piAi.InMemoryModelsStore !== "function" ? ["InMemoryModelsStore"] : []), ...(typeof piAi.InMemoryCredentialStore !== "function" ? ["InMemoryCredentialStore"] : []), ...(typeof piAi.modelsAreEqual !== "function" ? ["modelsAreEqual"] : [])].join(", ")})`);
}

const authPath = join(agentDir, "auth.json");
let authData = {};
try {
  authData = JSON.parse((await readFile(authPath, "utf8")).replace(/^\uFEFF/, ""));
} catch (error) {
  if (error?.code !== "ENOENT") refuse(`cannot read the selected Pi account's auth.json: ${error instanceof Error ? error.message : String(error)}`);
}
if (!authData || typeof authData !== "object" || Array.isArray(authData)) {
  refuse("the selected Pi account's auth.json is not a JSON object");
}
const credentials = new piAi.InMemoryCredentialStore();
for (const [providerId, credential] of Object.entries(authData)) {
  if (!credential || typeof credential !== "object" || Array.isArray(credential)) {
    refuse(`the selected Pi account has malformed credentials for provider '${providerId}'`);
  }
  await credentials.modify(providerId, async () => credential);
}

let runtime;
let settingsManager;
try {
  runtime = await pi.ModelRuntime.create({
    authPath,
    credentials,
    modelsPath: join(agentDir, "models.json"),
    modelsStore: new piAi.InMemoryModelsStore(),
    allowModelNetwork: false,
    modelRefreshTimeoutMs: 5000,
  });
  const projectTrusted = approveArgument === "1" || (approveArgument !== "2" &&
    (!pi.hasTrustRequiringProjectResources(cwd) || new pi.ProjectTrustStore(agentDir).get(cwd) === true));
  settingsManager = pi.SettingsManager.create(cwd, agentDir, { projectTrusted });
} catch (error) {
  refuse(`could not resolve the selected Pi account/model configuration: ${error instanceof Error ? error.message : String(error)}`);
}

let sessionContext;
if (sessionRef) {
  try {
    const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR || settingsManager.getSessionDir();
    let sessionPath;
    if (sessionRef.includes("/") || sessionRef.includes("\\") || sessionRef.endsWith(".jsonl")) {
      sessionPath = resolve(cwd, sessionRef);
    } else {
      sessionPath = pi.SessionManager.findById(cwd, sessionRef, sessionDir);
      if (!sessionPath) {
        const local = await pi.SessionManager.list(cwd, sessionDir);
        sessionPath = local.find((item) => item.id.startsWith(sessionRef))?.path;
      }
    }
    if (!sessionPath) refuse(`cannot resolve the Pi session selected for relaunch: ${sessionRef}`);
    sessionContext = pi.SessionManager.open(sessionPath, sessionDir).buildSessionContext();
  } catch (error) {
    refuse(`cannot read the Pi session selected for relaunch: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const modelText = modelArgument && modelArgument !== "-" && modelArgument !== "default" ? modelArgument : undefined;
let selectedModel;
if (modelText) {
  let resolved;
  try {
    resolved = pi.resolveCliModel({
      cliProvider: providerArgument || undefined,
      cliModel: modelText,
      cliThinking: effort,
      modelRuntime: runtime,
    });
  } catch (error) {
    refuse(`Pi could not resolve the selected model '${modelText}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!resolved.model) {
    refuse(`Pi could not resolve the selected model '${modelText}' in the pinned account/runtime${resolved.error ? `: ${resolved.error}` : ""}`);
  }
  selectedModel = resolved.model;
} else {
  const patterns = settingsManager.getEnabledModels();
  let scopedModels = [];
  if (patterns?.length) {
    try {
      const scope = await pi.resolveModelScopeWithDiagnostics(patterns, runtime, { signal: AbortSignal.timeout(5000) });
      scopedModels = scope.scopedModels;
    } catch (error) {
      refuse(`Pi could not resolve the configured model scope offline: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const continuing = Boolean(sessionContext?.messages.length);
  if (scopedModels.length > 0 && !continuing) {
    const defaultProvider = settingsManager.getDefaultProvider();
    const defaultModelId = settingsManager.getDefaultModel();
    const savedDefault = defaultProvider && defaultModelId ? runtime.getModel(defaultProvider, defaultModelId) : undefined;
    selectedModel = savedDefault
      ? scopedModels.find((entry) => piAi.modelsAreEqual(entry.model, savedDefault))?.model
      : undefined;
    selectedModel ??= scopedModels[0].model;
  } else {
    try {
      const { findInitialModel } = await import(pathToFileURL(join(packageRoot, "dist", "core", "model-resolver.js")).href);
      const initial = await findInitialModel({
        scopedModels,
        isContinuing: continuing,
        defaultProvider: settingsManager.getDefaultProvider(),
        defaultModelId: settingsManager.getDefaultModel(),
        defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
        modelThinkingLevels: settingsManager.getAllModelThinkingLevels(),
        modelRuntime: runtime,
      });
      selectedModel = initial.model;
    } catch (error) {
      refuse(`Pi could not resolve its selected default model: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (sessionContext?.model && selectedModel) {
      try {
        const { restoreModelFromSession } = await import(pathToFileURL(join(packageRoot, "dist", "core", "model-resolver.js")).href);
        const restored = await restoreModelFromSession(
          sessionContext.model.provider,
          sessionContext.model.modelId,
          selectedModel,
          false,
          runtime,
        );
        selectedModel = restored.model;
      } catch (error) {
        refuse(`Pi could not restore the selected session model: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (sessionContext?.model && !selectedModel) {
      selectedModel = runtime.getModel(sessionContext.model.provider, sessionContext.model.modelId);
      if (!selectedModel || !runtime.hasConfiguredAuth(selectedModel.provider)) {
        refuse("Pi cannot resolve the model recorded in the session and has no proven fallback model");
      }
    }
  }
}

if (!selectedModel) {
  refuse("Pi has no selected model to validate; configure a default model or pass --model explicitly");
}
const supported = piAi.getSupportedThinkingLevels(selectedModel);
if (!supported.includes(effort)) {
  refuse(`config/crew-effort pins worker effort to ${effort}, but Pi model ${selectedModel.provider}/${selectedModel.id} supports only ${supported.join("|")}; refusing rather than allowing Pi to clamp it`);
}
