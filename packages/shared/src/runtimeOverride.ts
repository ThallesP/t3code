// @effect-diagnostics nodeBuiltinImport:off -- Shared with the standalone service launcher and pre-CLI bootstrap, which run without Effect.
// @effect-diagnostics globalDate:off -- Standalone service launcher runs without Effect DateTime.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const RUNTIME_OVERRIDE_ENV_STOCK = "T3CODE_STOCK";
export const RUNTIME_OVERRIDE_ENV_ACTIVE = "T3CODE_RUNTIME_OVERRIDE_ACTIVE";
export const RUNTIME_OVERRIDE_ENV_ENTRY = "T3CODE_RUNTIME_OVERRIDE_ENTRY";
export const RUNTIME_OVERRIDE_ENV_STATIC_DIR = "T3CODE_STATIC_DIR";
export const RUNTIME_OVERRIDE_ENV_ENABLE_DEV = "T3CODE_ENABLE_RUNTIME_OVERRIDE";

export interface RuntimeOverrideModSummary {
  readonly id: string;
  readonly title: string;
  readonly verifySha256: string;
}

export interface RuntimeOverridePointer {
  readonly schemaVersion: 1;
  readonly buildId: string;
  readonly baseVersion: string;
  readonly artifactSha256: string;
  /** Absent when the build only changes the web client: the installed server keeps running. */
  readonly entryPath?: string;
  readonly clientAssetsDir: string;
  readonly mods: ReadonlyArray<RuntimeOverrideModSummary>;
  readonly activatedAt: string;
  readonly pendingTrial?: boolean;
  readonly trialStartedAt?: string;
  readonly trialPassedAt?: string;
}

export type RuntimeOverrideFallbackReason =
  | "version_mismatch"
  | "trial_crashed"
  | "startup_failed"
  | "missing_files"
  | "integrity_mismatch"
  | "invalid_manifest";

export interface RuntimeOverrideFallbackRecord {
  readonly schemaVersion: 1;
  readonly reason: RuntimeOverrideFallbackReason;
  readonly message: string;
  readonly buildId?: string;
  readonly overrideBaseVersion?: string;
  readonly currentVersion: string;
  readonly recordedAt: string;
}

export interface SavedModMetadata {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly title: string;
  readonly baseVersion: string;
  readonly enabled: boolean;
  readonly verifySha256: string;
  /** Where the check is written before it runs; absent for a repo-root script. */
  readonly verifyPath?: string;
  /** An update turned it off because it no longer fits. Gone once it is saved again. */
  readonly needsRepair?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PatchGuardrailResult {
  readonly files: ReadonlyArray<string>;
  readonly blocked: ReadonlyArray<string>;
  readonly warnings: ReadonlyArray<string>;
}

export type RuntimeOverrideResolution =
  | {
      readonly status: "override";
      readonly override: RuntimeOverridePointer;
    }
  | {
      readonly status: "stock";
      readonly reason: "none" | "stock_mode" | RuntimeOverrideFallbackReason;
      readonly fallback?: RuntimeOverrideFallbackRecord;
    };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MOD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function isValidModId(id: string): boolean {
  return MOD_ID_PATTERN.test(id);
}

/**
 * Mods live under the server's state dir, so a dev server (`<base>/dev`) can never write the
 * pointer an installed T3 Code (`<base>/userdata`) boots from.
 */
export function modsPaths(stateDir: string) {
  const modsDir = NodePath.join(stateDir, "mods");
  return {
    modsDir,
    activePath: NodePath.join(modsDir, "active.json"),
    fallbackPath: NodePath.join(modsDir, "fallback.json"),
    patchesDir: NodePath.join(modsDir, "patches"),
    buildsDir: NodePath.join(modsDir, "builds"),
    logsDir: NodePath.join(modsDir, "logs"),
    sourceDir: NodePath.join(modsDir, "source"),
  };
}

/** The state dir an installed (non-dev) server uses, for bootstraps that run before config. */
export function installedStateDir(baseDir: string): string {
  return NodePath.join(baseDir, "userdata");
}

export function isStockModeRequested(
  env: NodeJS.ProcessEnv,
  argv: ReadonlyArray<string> = [],
): boolean {
  const raw = env[RUNTIME_OVERRIDE_ENV_STOCK]?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return argv.includes("--stock");
}

const INFO_FLAGS = new Set(["--version", "--help", "-h", "--completions"]);
const VALUE_FLAGS = new Set([
  "--port",
  "--host",
  "--base-dir",
  "--dev-url",
  "--mode",
  "--bootstrap-fd",
  "--tailscale-serve-port",
  "--log-level",
]);

// Launchers probe `t3 --version` before every start; only a real start may begin a build's trial.
export function isServerStartInvocation(argv: ReadonlyArray<string>): boolean {
  if (argv.some((arg) => INFO_FLAGS.has(arg))) return false;
  const subcommand = argv.find(
    (arg, index) => !arg.startsWith("-") && !VALUE_FLAGS.has(argv[index - 1] ?? ""),
  );
  return subcommand === undefined || subcommand === "serve" || subcommand === "start";
}

export function computeTextSha256(text: string): string {
  return NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Deterministic SHA-256 fingerprint over the built server entry and client index/manifest.
 * Approval cards bind to this digest so the activated bundle matches what was verified.
 */
export function computeRuntimeOverrideArtifactSha256(
  entryPath: string | undefined,
  clientAssetsDir: string,
): string | null {
  try {
    const hash = NodeCrypto.createHash("sha256");
    if (entryPath !== undefined) {
      hash.update("entry:\0");
      hash.update(NodeFS.readFileSync(entryPath));
    }
    hash.update("\0index:\0");
    hash.update(NodeFS.readFileSync(NodePath.join(clientAssetsDir, "index.html")));
    const viteManifestPath = NodePath.join(clientAssetsDir, ".vite", "manifest.json");
    if (NodeFS.existsSync(viteManifestPath)) {
      hash.update("\0manifest:\0");
      hash.update(NodeFS.readFileSync(viteManifestPath));
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseRuntimeOverridePointer(raw: string): RuntimeOverridePointer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.schemaVersion !== 1) return null;
  if (
    !isNonEmptyString(parsed.buildId) ||
    !isNonEmptyString(parsed.baseVersion) ||
    typeof parsed.artifactSha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(parsed.artifactSha256) ||
    (parsed.entryPath !== undefined &&
      (!isNonEmptyString(parsed.entryPath) || !NodePath.isAbsolute(parsed.entryPath))) ||
    !isNonEmptyString(parsed.clientAssetsDir) ||
    !NodePath.isAbsolute(parsed.clientAssetsDir) ||
    !isNonEmptyString(parsed.activatedAt) ||
    !Array.isArray(parsed.mods)
  ) {
    return null;
  }

  const mods: Array<RuntimeOverrideModSummary> = [];
  for (const mod of parsed.mods) {
    if (
      !isRecord(mod) ||
      !isNonEmptyString(mod.id) ||
      !isNonEmptyString(mod.title) ||
      typeof mod.verifySha256 !== "string" ||
      !SHA256_HEX_PATTERN.test(mod.verifySha256)
    ) {
      return null;
    }
    mods.push({
      id: mod.id,
      title: mod.title,
      verifySha256: mod.verifySha256,
    });
  }

  return {
    schemaVersion: 1,
    buildId: parsed.buildId,
    baseVersion: parsed.baseVersion,
    artifactSha256: parsed.artifactSha256,
    ...(typeof parsed.entryPath === "string" ? { entryPath: parsed.entryPath } : {}),
    clientAssetsDir: parsed.clientAssetsDir,
    mods,
    activatedAt: parsed.activatedAt,
    ...(typeof parsed.pendingTrial === "boolean" ? { pendingTrial: parsed.pendingTrial } : {}),
    ...(isNonEmptyString(parsed.trialStartedAt) ? { trialStartedAt: parsed.trialStartedAt } : {}),
    ...(isNonEmptyString(parsed.trialPassedAt) ? { trialPassedAt: parsed.trialPassedAt } : {}),
  };
}

function parseRuntimeOverrideFallback(raw: string): RuntimeOverrideFallbackRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1) return null;
  const reason = parsed.reason;
  if (
    reason !== "version_mismatch" &&
    reason !== "trial_crashed" &&
    reason !== "startup_failed" &&
    reason !== "missing_files" &&
    reason !== "integrity_mismatch" &&
    reason !== "invalid_manifest"
  ) {
    return null;
  }
  if (
    !isNonEmptyString(parsed.message) ||
    !isNonEmptyString(parsed.currentVersion) ||
    !isNonEmptyString(parsed.recordedAt)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    reason,
    message: parsed.message,
    currentVersion: parsed.currentVersion,
    recordedAt: parsed.recordedAt,
    ...(isNonEmptyString(parsed.buildId) ? { buildId: parsed.buildId } : {}),
    ...(isNonEmptyString(parsed.overrideBaseVersion)
      ? { overrideBaseVersion: parsed.overrideBaseVersion }
      : {}),
  };
}

function writeJsonAtomicSync(filePath: string, value: unknown): void {
  const dir = NodePath.dirname(filePath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${NodeCrypto.randomBytes(6).toString("hex")}.tmp`;
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tempPath, filePath);
}

export function readRuntimeOverridePointer(stateDir: string): RuntimeOverridePointer | null {
  const { activePath } = modsPaths(stateDir);
  if (!NodeFS.existsSync(activePath)) return null;
  try {
    return parseRuntimeOverridePointer(NodeFS.readFileSync(activePath, "utf8"));
  } catch {
    return null;
  }
}

export function writeRuntimeOverridePointer(
  stateDir: string,
  pointer: RuntimeOverridePointer,
): void {
  writeJsonAtomicSync(modsPaths(stateDir).activePath, pointer);
}

export function clearRuntimeOverridePointer(stateDir: string): void {
  try {
    NodeFS.rmSync(modsPaths(stateDir).activePath, { force: true });
  } catch {
    // Ignore cleanup errors when already absent.
  }
}

export function readRuntimeOverrideFallback(
  stateDir: string,
): RuntimeOverrideFallbackRecord | null {
  const { fallbackPath } = modsPaths(stateDir);
  if (!NodeFS.existsSync(fallbackPath)) return null;
  try {
    return parseRuntimeOverrideFallback(NodeFS.readFileSync(fallbackPath, "utf8"));
  } catch {
    return null;
  }
}

function writeRuntimeOverrideFallback(
  stateDir: string,
  record: RuntimeOverrideFallbackRecord,
): void {
  writeJsonAtomicSync(modsPaths(stateDir).fallbackPath, record);
}

export function clearRuntimeOverrideFallback(stateDir: string): void {
  try {
    NodeFS.rmSync(modsPaths(stateDir).fallbackPath, { force: true });
  } catch {
    // Ignore cleanup errors when already absent.
  }
}

function recordAndDisable(
  stateDir: string,
  record: RuntimeOverrideFallbackRecord,
): RuntimeOverrideResolution {
  clearRuntimeOverridePointer(stateDir);
  writeRuntimeOverrideFallback(stateDir, record);
  return { status: "stock", reason: record.reason, fallback: record };
}

export function resolveActiveRuntimeOverride(input: {
  readonly stateDir: string;
  readonly currentVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
  readonly nowIso?: string;
}): RuntimeOverrideResolution {
  const env = input.env ?? {};
  const argv = input.argv ?? [];
  if (isStockModeRequested(env, argv)) {
    return { status: "stock", reason: "stock_mode" };
  }

  const { activePath } = modsPaths(input.stateDir);
  if (!NodeFS.existsSync(activePath)) {
    return { status: "stock", reason: "none" };
  }

  const nowIso = input.nowIso ?? new Date().toISOString();
  let raw: string;
  try {
    raw = NodeFS.readFileSync(activePath, "utf8");
  } catch {
    return { status: "stock", reason: "none" };
  }

  const pointer = parseRuntimeOverridePointer(raw);
  if (pointer === null) {
    return recordAndDisable(input.stateDir, {
      schemaVersion: 1,
      reason: "invalid_manifest",
      message: "Custom runtime pointer was unreadable; fell back to stock T3 Code.",
      currentVersion: input.currentVersion,
      recordedAt: nowIso,
    });
  }

  if (pointer.baseVersion !== input.currentVersion) {
    return recordAndDisable(input.stateDir, {
      schemaVersion: 1,
      reason: "version_mismatch",
      message: `Customizations built for ${pointer.baseVersion} were paused after updating to ${input.currentVersion}. T3 Code rebuilds the ones that still fit by itself.`,
      buildId: pointer.buildId,
      overrideBaseVersion: pointer.baseVersion,
      currentVersion: input.currentVersion,
      recordedAt: nowIso,
    });
  }

  if (pointer.pendingTrial && pointer.trialStartedAt && !pointer.trialPassedAt) {
    return recordAndDisable(input.stateDir, {
      schemaVersion: 1,
      reason: "trial_crashed",
      message: `Custom build ${pointer.buildId} did not finish startup on its trial run; fell back to stock T3 Code.`,
      buildId: pointer.buildId,
      overrideBaseVersion: pointer.baseVersion,
      currentVersion: input.currentVersion,
      recordedAt: nowIso,
    });
  }

  const clientIndexPath = NodePath.join(pointer.clientAssetsDir, "index.html");
  if (
    (pointer.entryPath !== undefined && !NodeFS.existsSync(pointer.entryPath)) ||
    !NodeFS.existsSync(clientIndexPath)
  ) {
    return recordAndDisable(input.stateDir, {
      schemaVersion: 1,
      reason: "missing_files",
      message: `Custom build ${pointer.buildId} is missing built server or client assets; fell back to stock T3 Code.`,
      buildId: pointer.buildId,
      overrideBaseVersion: pointer.baseVersion,
      currentVersion: input.currentVersion,
      recordedAt: nowIso,
    });
  }

  const actualSha = computeRuntimeOverrideArtifactSha256(
    pointer.entryPath,
    pointer.clientAssetsDir,
  );
  if (actualSha === null || actualSha !== pointer.artifactSha256) {
    return recordAndDisable(input.stateDir, {
      schemaVersion: 1,
      reason: "integrity_mismatch",
      message: `Custom build ${pointer.buildId} failed its integrity check; fell back to stock T3 Code.`,
      buildId: pointer.buildId,
      overrideBaseVersion: pointer.baseVersion,
      currentVersion: input.currentVersion,
      recordedAt: nowIso,
    });
  }

  return { status: "override", override: pointer };
}

export function markRuntimeOverrideTrialStarted(stateDir: string, nowIso?: string): void {
  const pointer = readRuntimeOverridePointer(stateDir);
  if (pointer === null || !pointer.pendingTrial || pointer.trialStartedAt !== undefined) return;
  writeRuntimeOverridePointer(stateDir, {
    ...pointer,
    trialStartedAt: nowIso ?? new Date().toISOString(),
  });
}

export function markRuntimeOverrideHealthy(stateDir: string, nowIso?: string): void {
  const pointer = readRuntimeOverridePointer(stateDir);
  if (pointer === null) return;
  if (pointer.pendingTrial || pointer.trialPassedAt === undefined) {
    writeRuntimeOverridePointer(stateDir, {
      ...pointer,
      pendingTrial: false,
      trialPassedAt: nowIso ?? new Date().toISOString(),
    });
  }
  clearRuntimeOverrideFallback(stateDir);
}

export function failRuntimeOverrideStartup(input: {
  readonly stateDir: string;
  readonly currentVersion: string;
  readonly message: string;
  readonly nowIso?: string;
}): RuntimeOverrideFallbackRecord {
  const pointer = readRuntimeOverridePointer(input.stateDir);
  const record: RuntimeOverrideFallbackRecord = {
    schemaVersion: 1,
    reason: "startup_failed",
    message: input.message,
    currentVersion: input.currentVersion,
    recordedAt: input.nowIso ?? new Date().toISOString(),
    ...(pointer !== null
      ? { buildId: pointer.buildId, overrideBaseVersion: pointer.baseVersion }
      : {}),
  };
  clearRuntimeOverridePointer(input.stateDir);
  writeRuntimeOverrideFallback(input.stateDir, record);
  return record;
}

const WEB_CLIENT_PATH_PATTERN = /^apps\/web\//;

interface ClaimedRuntimeOverride {
  readonly entryPath: string;
  readonly clientAssetsDir: string | undefined;
  /** The installed server's folder, where its interface and native packages are. */
  readonly stockDir: string;
}

// A custom build is its own bundle with its own copy of this module, so the value is kept on
// the process, not in module state.
const CLAIMED_RUNTIME_OVERRIDE = Symbol.for("@t3tools/shared/runtimeOverride/claimed");
const processSlot = globalThis as { [CLAIMED_RUNTIME_OVERRIDE]?: ClaimedRuntimeOverride | null };

/**
 * Takes the custom build a launcher handed this process through its environment, and removes
 * those variables. The agents and shells a server starts inherit its environment: left in
 * place, every `t3` they ran would load this build too, a dev server included.
 */
export function claimRuntimeOverride(
  env: NodeJS.ProcessEnv,
  stockDir: string,
): ClaimedRuntimeOverride | null {
  if (env[RUNTIME_OVERRIDE_ENV_ACTIVE] !== "1") return claimedRuntimeOverride();
  const entryPath = env[RUNTIME_OVERRIDE_ENV_ENTRY]?.trim();
  const claimed = entryPath
    ? {
        entryPath,
        clientAssetsDir: env[RUNTIME_OVERRIDE_ENV_STATIC_DIR]?.trim() || undefined,
        stockDir,
      }
    : null;
  delete env[RUNTIME_OVERRIDE_ENV_ACTIVE];
  delete env[RUNTIME_OVERRIDE_ENV_ENTRY];
  delete env[RUNTIME_OVERRIDE_ENV_STATIC_DIR];
  processSlot[CLAIMED_RUNTIME_OVERRIDE] = claimed;
  return claimed;
}

/** The custom build this process runs, or `null` when it runs stock T3 Code. */
export function claimedRuntimeOverride(): ClaimedRuntimeOverride | null {
  return processSlot[CLAIMED_RUNTIME_OVERRIDE] ?? null;
}

export function releaseRuntimeOverride(): void {
  processSlot[CLAIMED_RUNTIME_OVERRIDE] = null;
}

/** True when a change stays inside the web client, so the installed server can keep running. */
export function isClientOnlyChange(files: ReadonlyArray<string>): boolean {
  return files.length > 0 && files.every((file) => WEB_CLIENT_PATH_PATTERN.test(file));
}

/** What a server process needs to boot a custom build. A client-only build needs nothing. */
export function runtimeOverrideEnv(
  override: Pick<RuntimeOverridePointer, "entryPath" | "clientAssetsDir">,
): Record<string, string> {
  if (override.entryPath === undefined) return {};
  return {
    [RUNTIME_OVERRIDE_ENV_ACTIVE]: "1",
    [RUNTIME_OVERRIDE_ENV_ENTRY]: override.entryPath,
    [RUNTIME_OVERRIDE_ENV_STATIC_DIR]: override.clientAssetsDir,
  };
}

/**
 * The client folder of an applied client-only build, read fresh so applying or turning one off
 * shows on the next page load with no restart. Null means the installed client.
 */
export function readLiveClientAssetsDir(input: {
  readonly stateDir: string;
  readonly currentVersion: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: ReadonlyArray<string>;
}): string | null {
  if (isStockModeRequested(input.env ?? {}, input.argv)) return null;
  const pointer = readRuntimeOverridePointer(input.stateDir);
  if (
    pointer === null ||
    pointer.entryPath !== undefined ||
    pointer.baseVersion !== input.currentVersion ||
    !NodeFS.existsSync(NodePath.join(pointer.clientAssetsDir, "index.html"))
  ) {
    return null;
  }
  return pointer.clientAssetsDir;
}

const MIGRATION_PATH_PATTERN = /(?:^|\/)apps\/server\/src\/persistence\/migrations\//i;
const DESKTOP_SHELL_PATH_PATTERN = /(?:^|\/)apps\/desktop\/src\//;
const MOBILE_APP_PATH_PATTERN = /(?:^|\/)apps\/mobile\/src\//;
const DEPENDENCY_MANIFEST_PATTERN = /(?:^|\/)(?:package\.json|pnpm-lock\.yaml)$/;

/**
 * Parses touched paths in a unified diff and enforces static guardrails so local mods cannot
 * collide with upstream SQLite migrations or silently assume Electron/mobile rebuilds.
 */
export function checkPatchGuardrails(patchDiff: string): PatchGuardrailResult {
  const files = new Set<string>();
  const blocked: Array<string> = [];
  const warnings: Array<string> = [];

  for (const line of patchDiff.split(/\r?\n/)) {
    if (line.startsWith("GIT binary patch")) {
      blocked.push("Binary patches are not supported in local mods.");
      continue;
    }
    const diffGit = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffGit?.[2]) {
      files.add(diffGit[2]);
      continue;
    }
    if (line.startsWith("+++ b/")) {
      files.add(line.slice("+++ b/".length).trim());
    }
  }

  const sortedFiles = [...files].sort();
  let hasDesktopWarning = false;
  let hasMobileWarning = false;
  let hasDependencyWarning = false;

  for (const file of sortedFiles) {
    if (MIGRATION_PATH_PATTERN.test(file)) {
      blocked.push(
        `Core SQLite migrations (${file}) cannot be modified by local mods because upstream updates will collide on migration numbers.`,
      );
    }
    if (!hasDesktopWarning && DESKTOP_SHELL_PATH_PATTERN.test(file)) {
      hasDesktopWarning = true;
      warnings.push(
        "Changes under apps/desktop/src/ require rebuilding the Electron shell and are not hot-swapped by the runtime override bundle.",
      );
    }
    if (!hasDependencyWarning && DEPENDENCY_MANIFEST_PATTERN.test(file)) {
      hasDependencyWarning = true;
      warnings.push(
        "Dependency changes are bundled, but native and externally loaded packages still come from the installed T3 Code.",
      );
    }
    if (!hasMobileWarning && MOBILE_APP_PATH_PATTERN.test(file)) {
      hasMobileWarning = true;
      warnings.push(
        "Changes under apps/mobile/src/ require rebuilding the native mobile app and are not included in the runtime override bundle.",
      );
    }
  }

  return { files: sortedFiles, blocked, warnings };
}
