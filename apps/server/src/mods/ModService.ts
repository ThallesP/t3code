// @effect-diagnostics nodeBuiltinImport:off -- Only asks whether this process is a single executable.
import * as NodeSea from "node:sea";

import { type ModApprovalPreview } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import {
  checkPatchGuardrails,
  clearRuntimeOverrideFallback,
  clearRuntimeOverridePointer,
  computeRuntimeOverrideArtifactSha256,
  computeTextSha256,
  isClientOnlyChange,
  isValidModId,
  modsPaths,
  readRuntimeOverrideFallback,
  readRuntimeOverridePointer,
  claimedRuntimeOverride,
  RUNTIME_OVERRIDE_ENV_STATIC_DIR,
  runtimeOverrideEnv,
  type RuntimeOverrideFallbackRecord,
  type RuntimeOverrideModSummary,
  type RuntimeOverridePointer,
  type SavedModMetadata,
  writeRuntimeOverridePointer,
} from "@t3tools/shared/runtimeOverride";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";

import packageJson from "../../package.json" with { type: "json" };
import { resolveEntryPath } from "../cli/invocation.ts";
import { hasCloudPublicConfig } from "../cloud/publicConfig.ts";
import * as ServerConfig from "../config.ts";
import {
  type BuildPackEntry,
  copyInstalledFile,
  installedFileExists,
  installedPackagesDir,
  isSafePackName,
  linkDirectory,
  listInstalledFiles,
  readBuildPack,
  readInstalledText,
  writeBuildPack,
} from "./ModBuildPack.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParked } from "../serverActivation.ts";

declare const __T3CODE_BUILD_SOURCE_REPOSITORY__: string | undefined;
// A fork's build names its own repository; anything else is built from upstream.
const SOURCE_REPOSITORY =
  (typeof __T3CODE_BUILD_SOURCE_REPOSITORY__ === "undefined"
    ? ""
    : __T3CODE_BUILD_SOURCE_REPOSITORY__.trim()) || packageJson.repository.url;

const DIFF_PREVIEW_MAX_CHARS = 16_000;
const FAILURE_TAIL_MAX_CHARS = 1_500;
const STEP_OUTPUT_MAX_BYTES = 4 * 1024 * 1024;
const VERIFY_SCRIPT_FILENAME = ".t3-mod-verify.ts";
const BUILD_MANIFEST_FILE = "manifest.json";
const BUILD_PROPOSED_MOD_DIR = "mod";
const MOD_METADATA_FILE = "mod.json";
const MOD_INTENT_FILE = "intent.md";
const MOD_VERIFY_FILE = "verify.ts";
const MOD_PATCH_FILE = "patch.diff";
const MOD_FILES = [MOD_METADATA_FILE, MOD_INTENT_FILE, MOD_VERIFY_FILE, MOD_PATCH_FILE];
const SOURCE_WORKTREES_SUFFIX = "-mods";
const BUILD_CHECKOUT_NAME = ".build";
// Where the check runs, so it can run while the candidate builds.
const CHECK_CHECKOUT_NAME = ".check";
// refs/worktree/* is private to each worktree, so every workspace keeps its own base.
const WORKSPACE_BASE_REF = "refs/worktree/t3-mod-base";
// The stock commit under that base, to tell when T3 Code itself moved on.
const WORKSPACE_STOCK_REF = "refs/worktree/t3-mod-stock";
// The plain build stamps development icons; a candidate keeps the installed app's.
const CLIENT_ICON_FILES = [
  "favicon.ico",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192x192.png",
  "icon-512x512.png",
] as const;
// The CLI module on its own: unlike bin.mjs it has no top-level await, so require() can load it.
const CUSTOM_BUILD_ENTRY = "binMain.mjs";
const BUILD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PAIRING_URL_PATTERN = /Pairing URL: (\S+)/;
// Strips terminal colors from build output.
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;

const SANITIZED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TERM",
  "NODE_OPTIONS",
  "PNPM_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  // The desktop app's server is Electron running as Node; scripts it starts must be too.
  "ELECTRON_RUN_AS_NODE",
] as const;

const SavedModMetadataSchema = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    id: Schema.String,
    title: Schema.String,
    baseVersion: Schema.String,
    enabled: Schema.Boolean,
    verifySha256: Schema.String,
    verifyPath: Schema.optionalKey(Schema.String),
    needsRepair: Schema.optionalKey(Schema.Boolean),
    createdAt: Schema.String,
    updatedAt: Schema.String,
  }),
);
const decodeSavedModMetadata = Schema.decodeUnknownOption(SavedModMetadataSchema);
const encodeSavedModMetadata = Schema.encodeEffect(SavedModMetadataSchema);

const BuildManifestSchema = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    buildId: Schema.String,
    baseVersion: Schema.String,
    artifactSha256: Schema.String,
    /** Absent when every mod in the build only changes the web client. */
    entryPath: Schema.optionalKey(Schema.String),
    clientAssetsDir: Schema.String,
    /** Absent for a build this machine made by itself after an update. */
    proposedModId: Schema.optionalKey(Schema.String),
    /** The checkout the proposed change was written in; removed once it is applied. */
    sourceDir: Schema.String,
    workspaceDir: Schema.String,
    /** Saved mods that no longer apply to this version. Applying this build turns them off. */
    skippedModIds: Schema.Array(Schema.String),
    // Every mod compiled into this build, the proposed one included.
    mods: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        verifySha256: Schema.String,
        patchSha256: Schema.String,
      }),
    ),
    createdAt: Schema.String,
  }),
);
const decodeBuildManifest = Schema.decodeUnknownOption(BuildManifestSchema);
const encodeBuildManifest = Schema.encodeEffect(BuildManifestSchema);

const decodeViteManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        file: Schema.String,
        css: Schema.optionalKey(Schema.Array(Schema.String)),
        assets: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
);

const decodePackageName = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String })),
);

export interface SavedModRecord {
  readonly metadata: SavedModMetadata;
  readonly intent: string;
  readonly verifySource: string;
  readonly patchDiff: string;
  readonly dirPath: string;
  readonly verifyTampered: boolean;
}

export interface ModStatusSnapshot {
  readonly currentVersion: string;
  readonly activeOverride: RuntimeOverridePointer | null;
  readonly fallback: RuntimeOverrideFallbackRecord | null;
  readonly mods: ReadonlyArray<SavedModRecord>;
  /** Approved mods an update left out of what runs, until a build of them is applied again. */
  readonly paused: ReadonlyArray<SavedModRecord>;
  /** This machine is making that build itself right now. */
  readonly rebuilding: boolean;
  /** Why its last try at that failed. */
  readonly rebuildFailure: string | null;
}

/** Installs dependencies and bundles a patched checkout. Tests swap it for a fake. */
export interface ModBuilder {
  readonly install: (input: {
    readonly worktreeDir: string;
    readonly env: NodeJS.ProcessEnv;
    readonly logPath: string;
  }) => Effect.Effect<void, ModServiceError>;
  readonly bundle: (input: {
    readonly worktreeDir: string;
    readonly buildDir: string;
    /** Build the web client alone; the installed server keeps running. */
    readonly clientOnly: boolean;
    readonly env: NodeJS.ProcessEnv;
    readonly logPath: string;
  }) => Effect.Effect<
    { readonly entryPath?: string; readonly clientAssetsDir: string },
    ModServiceError
  >;
}

export interface StartModWorkspaceInput {
  readonly id: string;
  /** Throw away earlier edits and start again from the saved mod. */
  readonly reset?: boolean | undefined;
  readonly sourceDir?: string | undefined;
  readonly builder?: ModBuilder | undefined;
}

export interface ModBuildDescription {
  readonly buildId: string;
  readonly baseVersion: string;
  readonly artifactSha256: string;
  readonly restartRequired: boolean;
  /** Paths inside the build's interface folder. Hashed ones may already be on the other side. */
  readonly clientFiles: ReadonlyArray<string>;
  readonly mods: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly patchSha256: string;
  }>;
}

export interface ModWorkspace {
  readonly workspaceDir: string;
  readonly created: boolean;
  /** T3 Code's source moved on since this workspace was made. */
  readonly baseOutdated: boolean;
  readonly savedPatch: "none" | "applied" | "conflicted" | "kept";
  /** The user's other mods this workspace is built on, so their changes are already in it. */
  readonly builtOn: ReadonlyArray<{ readonly id: string; readonly title: string }>;
}

/** The change itself is whatever the mod's workspace holds when this is called. */
export interface PrepareModCandidateInput {
  readonly id: string;
  readonly title: string;
  readonly intent: string;
  readonly verifySource: string;
  /** Repo-relative. A `*.test.ts(x)` path runs in its package's test runner. */
  readonly verifyPath?: string | undefined;
  readonly sourceDir?: string | undefined;
  readonly builder?: ModBuilder | undefined;
}

export interface ModUpgradeCheckEntry {
  readonly id: string;
  readonly title: string;
  readonly previousBaseVersion: string;
  readonly status: "already_fixed_upstream" | "ready" | "needs_repair" | "verify_tampered";
  readonly detail: string;
  readonly intent: string;
}

export class ModServiceError extends Schema.TaggedError<ModServiceError>()("ModServiceError", {
  stage: Schema.Literals([
    "validation",
    "guardrail",
    "source",
    "verify",
    "patch",
    "build",
    "preview",
    "activate",
    "storage",
  ]),
  reason: Schema.String,
  /** Why an approved build could not be applied, when the user can act on it. */
  activation: Schema.optionalKey(
    Schema.Literals(["dev_server", "stale_build", "artifact_mismatch", "build_missing"]),
  ),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

export class ModService extends Context.Service<
  ModService,
  {
    readonly status: () => Effect.Effect<ModStatusSnapshot, ModServiceError>;
    readonly listMods: () => Effect.Effect<ReadonlyArray<SavedModRecord>, ModServiceError>;
    readonly startWorkspace: (
      input: StartModWorkspaceInput,
    ) => Effect.Effect<ModWorkspace, ModServiceError>;
    readonly prepareCandidate: (
      input: PrepareModCandidateInput,
    ) => Effect.Effect<ModApprovalPreview, ModServiceError>;
    readonly previewCandidate: (input: {
      readonly buildId: string;
    }) => Effect.Effect<{ readonly previewUrl: string }, ModServiceError>;
    readonly activateBuild: (input: {
      readonly buildId: string;
      readonly expectedArtifactSha256: string;
    }) => Effect.Effect<{ readonly restartRequired: boolean }, ModServiceError>;
    /** Deletes a candidate that was declined or replaced. The active build is never deleted. */
    readonly discardCandidate: (input: {
      readonly buildId: string;
    }) => Effect.Effect<void, ModServiceError>;
    readonly disableAll: () => Effect.Effect<
      { readonly restartRequired: boolean },
      ModServiceError
    >;
    readonly setModEnabled: (input: {
      readonly id: string;
      readonly enabled: boolean;
    }) => Effect.Effect<void, ModServiceError>;
    /** What another machine needs to know to take over a build that was made here. */
    readonly describeBuild: (input: {
      readonly buildId: string;
    }) => Effect.Effect<ModBuildDescription, ModServiceError>;
    /** The interface files of a build that this machine has no copy of yet. */
    readonly missingClientFiles: (
      files: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>>;
    /** Packs a build into one file at `packPath`, with only the named interface files. */
    readonly packBuild: (input: {
      readonly buildId: string;
      readonly clientFiles: ReadonlyArray<string>;
      readonly packPath: string;
    }) => Effect.Effect<void, ModServiceError>;
    /** Applies a build that was made on another machine running the same T3 Code version. */
    readonly installBuild: (input: {
      readonly packPath: string;
    }) => Effect.Effect<
      { readonly buildId: string; readonly restartRequired: boolean },
      ModServiceError
    >;
    readonly exportMod: (input: {
      readonly id: string;
      readonly destinationDir: string;
    }) => Effect.Effect<{ readonly exportedDir: string }, ModServiceError>;
    readonly importMod: (input: {
      readonly sourceModDir: string;
    }) => Effect.Effect<SavedModRecord, ModServiceError>;
    readonly checkUpgrade: (input?: {
      readonly sourceDir?: string | undefined;
      readonly builder?: ModBuilder | undefined;
    }) => Effect.Effect<ReadonlyArray<ModUpgradeCheckEntry>, ModServiceError>;
    /**
     * Brings the user's mods back after an update: builds the ones that still fit this version
     * and applies that build. One that no longer fits is turned off and marked for repair.
     * Does nothing on a machine that has never built a mod, which waits for a copy.
     */
    readonly rebuildAfterUpdate: (input?: {
      readonly sourceDir?: string | undefined;
      readonly builder?: ModBuilder | undefined;
    }) => Effect.Effect<void, ModServiceError>;
  }
>()("t3/mods/ModService") {}

function sanitizedModEnv(inherited: NodeJS.ProcessEnv, isolatedHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    T3CODE_HOME: isolatedHome,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    CI: "1",
  };
  for (const key of SANITIZED_ENV_KEYS) {
    const value = inherited[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

const isTestFilePath = (filePath: string) => /\.test\.tsx?$/.test(filePath);

const isSafeVerifyPath = (filePath: string) =>
  /\.tsx?$/.test(filePath) &&
  !/^(?:[\\/]|[A-Za-z]:)/.test(filePath) &&
  !filePath.split(/[\\/]/).some((segment) => segment === ".." || segment === ".git");

function truncateDiff(patchDiff: string): {
  readonly diffPreview: string;
  readonly diffTruncated: boolean;
} {
  if (patchDiff.length <= DIFF_PREVIEW_MAX_CHARS) {
    return { diffPreview: patchDiff, diffTruncated: false };
  }
  return {
    diffPreview: `${patchDiff.slice(0, DIFF_PREVIEW_MAX_CHARS)}\n... [truncated]`,
    diffTruncated: true,
  };
}

// Failures print last, after pages of bundler output.
function tailOutput(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()]
    .filter((part) => part.length > 0)
    .join("\n")
    .replace(ANSI_PATTERN, "");
  if (combined.length === 0) return "No output.";
  return combined.length <= FAILURE_TAIL_MAX_CHARS
    ? combined
    : `...${combined.slice(-FAILURE_TAIL_MAX_CHARS)}`;
}

const failAs =
  (stage: ModServiceError["stage"], reason: string) =>
  (cause: unknown): ModServiceError =>
    new ModServiceError({ stage, reason, cause });

interface ModSource {
  readonly dir: string;
  /** Null builds from the checkout as it is on disk, uncommitted work included. */
  readonly ref: string | null;
}

interface StepResult {
  readonly passed: boolean;
  readonly output: string;
  readonly logPath: string;
}

interface ActivePreviewProcess {
  readonly buildId: string;
  readonly scope: Scope.Closeable;
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const net = yield* NetService.NetService;
  const random = yield* SecureRandom.SecureRandom;
  const hostEnv = yield* HostProcess.Environment;
  const hostExecutable = yield* HostProcess.ExecutablePath;
  // How this server was started: a candidate is previewed by the same entry that would boot it.
  const stockEntryPath = yield* resolveEntryPath;
  const stockCommand = (yield* HostProcess.IsExecutable)
    ? [hostExecutable]
    : [hostExecutable, stockEntryPath];
  const pathDelimiter = (yield* HostProcess.Platform) === "win32" ? ";" : ":";
  const serviceScope = yield* Scope.Scope;

  const paths = modsPaths(config.stateDir);
  const currentVersion = packageJson.version;
  // A single-executable install has no `node` of its own to run scripts with.
  const nodeCommand = NodeSea.isSea() ? "node" : hostExecutable;
  // This process loaded a mod's server build, so only a restart brings another server in.
  const runsCustomServer = claimedRuntimeOverride() !== null;
  const activePreviewRef = yield* Ref.make<Option.Option<ActivePreviewProcess>>(Option.none());
  // One build checkout per source, so candidates build one at a time.
  const buildLock = yield* Semaphore.make(1);
  const rebuilding = yield* Ref.make(false);
  const rebuildFailure = yield* Ref.make<string | null>(null);

  const closeScope = (scope: Scope.Closeable) => Scope.close(scope, Exit.void).pipe(Effect.ignore);

  const stopActivePreview = Effect.fn("ModService.stopActivePreview")(function* () {
    const existing = yield* Ref.getAndSet(activePreviewRef, Option.none());
    if (Option.isSome(existing)) yield* closeScope(existing.value.scope);
  });

  yield* Effect.addFinalizer(() => stopActivePreview());

  const exists = (target: string) => fs.exists(target).pipe(Effect.orElseSucceed(() => false));

  const runStep = Effect.fn("ModService.runStep")(function* (input: {
    readonly stage: ModServiceError["stage"];
    readonly label: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly logPath: string;
    readonly timeout: Duration.Input;
  }) {
    const result = yield* runner.run({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      env: input.env,
      extendEnv: false,
      timeout: input.timeout,
      timeoutBehavior: "timedOutResult",
      outputMode: "truncate",
      maxOutputBytes: STEP_OUTPUT_MAX_BYTES,
    });
    const output = result.timedOut
      ? `${input.label} timed out.`
      : tailOutput(result.stdout, result.stderr);
    yield* fs.makeDirectory(path.dirname(input.logPath), { recursive: true }).pipe(Effect.ignore);
    yield* fs
      .writeFileString(
        input.logPath,
        result.timedOut
          ? `${output}\n`
          : `${result.stdout}\n${result.stderr}`.replace(ANSI_PATTERN, ""),
      )
      .pipe(Effect.ignore);
    return {
      passed: result.code === 0 && !result.timedOut,
      output,
      logPath: input.logPath,
    } satisfies StepResult;
  });

  const describeFailure = (label: string, step: StepResult) =>
    `${label}: ${step.output}\nFull log: ${step.logPath}`;

  const git = Effect.fn("ModService.git")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    options: {
      readonly stdin?: string;
      readonly env?: NodeJS.ProcessEnv;
      readonly timeout?: Duration.Input;
    } = {},
  ) {
    const result = yield* runner
      .run({
        command: "git",
        args,
        cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        timeout: options.timeout ?? Duration.minutes(2),
        outputMode: "truncate",
        maxOutputBytes: STEP_OUTPUT_MAX_BYTES,
      })
      .pipe(Effect.mapError(failAs("source", `Could not run git ${args[0] ?? ""}.`)));
    return {
      ok: result.code === 0,
      stdout: result.stdout,
      output: tailOutput(result.stdout, result.stderr),
    };
  });

  const gitOrFail = Effect.fn("ModService.gitOrFail")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    stage: ModServiceError["stage"],
    label: string,
    options: Parameters<typeof git>[2] = {},
  ) {
    const result = yield* git(cwd, args, options);
    if (!result.ok) {
      return yield* new ModServiceError({ stage, reason: `${label}: ${result.output}` });
    }
    return result.stdout;
  });

  const isT3CodeCheckout = Effect.fn("ModService.isT3CodeCheckout")(function* (dir: string) {
    if (!(yield* exists(path.join(dir, ".git")))) return false;
    const manifest = yield* fs
      .readFileString(path.join(dir, "apps", "server", "package.json"))
      .pipe(Effect.option);
    if (Option.isNone(manifest)) return false;
    return Option.match(decodePackageName(manifest.value), {
      onNone: () => false,
      onSome: (decoded) => decoded.name === packageJson.name,
    });
  });

  const findAncestor = Effect.fn("ModService.findAncestor")(function* (
    start: string,
    matches: (dir: string) => Effect.Effect<boolean>,
  ) {
    let dir = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (yield* matches(dir)) return Option.some(dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return Option.none<string>();
  });

  const resolveSource = Effect.fn("ModService.resolveSource")(function* (
    explicitSourceDir?: string,
  ) {
    const requested = explicitSourceDir?.trim() || hostEnv.T3CODE_MOD_SOURCE_DIR?.trim();
    if (requested) {
      const dir = path.resolve(requested);
      if (!(yield* exists(path.join(dir, ".git")))) {
        return yield* new ModServiceError({
          stage: "source",
          reason: `${dir} is not a git checkout of T3 Code.`,
        });
      }
      return { dir, ref: null } satisfies ModSource;
    }

    // A server started from a checkout customizes that checkout.
    const running = yield* findAncestor(import.meta.dirname, isT3CodeCheckout);
    if (Option.isSome(running)) return { dir: running.value, ref: null } satisfies ModSource;

    const tag = `refs/tags/v${currentVersion}`;
    const repositoryUrl = SOURCE_REPOSITORY;
    if (!(yield* exists(path.join(paths.sourceDir, ".git")))) {
      yield* fs
        .makeDirectory(paths.modsDir, { recursive: true })
        .pipe(Effect.mapError(failAs("storage", "Could not create the mods folder.")));
      yield* gitOrFail(
        paths.modsDir,
        ["clone", "--filter=blob:none", "--no-checkout", repositoryUrl, paths.sourceDir],
        "source",
        `Could not download T3 Code's source from ${repositoryUrl}`,
        { timeout: Duration.minutes(15) },
      );
    }
    const hasTag = () =>
      git(paths.sourceDir, ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]).pipe(
        Effect.map((result) => result.ok),
      );
    if (!(yield* hasTag())) {
      yield* git(paths.sourceDir, ["fetch", "--quiet", "origin", `${tag}:${tag}`], {
        timeout: Duration.minutes(15),
      });
    }
    if (!(yield* hasTag())) {
      return yield* new ModServiceError({
        stage: "source",
        reason: `${repositoryUrl} has no v${currentVersion} tag, so the source this T3 Code was built from is unknown. Set T3CODE_MOD_SOURCE_DIR to a checkout of it.`,
      });
    }
    // The managed source may be a link to a checkout kept elsewhere, such as on a bigger disk;
    // mod checkouts are made beside the real one.
    const managedDir = yield* fs
      .realPath(paths.sourceDir)
      .pipe(Effect.orElseSucceed(() => paths.sourceDir));
    return { dir: managedDir, ref: tag } satisfies ModSource;
  });

  /** The commit candidates start from: the release tag, or the checkout exactly as it is. */
  const resolveBaseCommit = Effect.fn("ModService.resolveBaseCommit")(function* (
    source: ModSource,
  ) {
    if (source.ref !== null) {
      return (yield* gitOrFail(
        source.dir,
        ["rev-parse", `${source.ref}^{commit}`],
        "source",
        "Could not read the T3 Code source version",
      )).trim();
    }
    const head = (yield* gitOrFail(
      source.dir,
      ["rev-parse", "HEAD^{commit}"],
      "source",
      "Could not read the T3 Code checkout",
    )).trim();
    const dirty = yield* gitOrFail(
      source.dir,
      ["status", "--porcelain"],
      "source",
      "Could not read the T3 Code checkout",
    );
    if (dirty.trim().length === 0) return head;

    // Snapshot through a scratch index so the developer's own index and HEAD stay untouched.
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const scratch = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-mod-index-" })
          .pipe(Effect.mapError(failAs("source", "Could not snapshot the T3 Code checkout.")));
        const indexPath = path.join(scratch, "index");
        const realIndex = path.resolve(
          source.dir,
          (yield* gitOrFail(
            source.dir,
            ["rev-parse", "--git-path", "index"],
            "source",
            "Could not read the T3 Code checkout",
          )).trim(),
        );
        yield* fs.copyFile(realIndex, indexPath).pipe(Effect.ignore);
        const env = {
          GIT_INDEX_FILE: indexPath,
          GIT_AUTHOR_NAME: "T3 Code",
          GIT_AUTHOR_EMAIL: "mods@t3.codes",
          GIT_COMMITTER_NAME: "T3 Code",
          GIT_COMMITTER_EMAIL: "mods@t3.codes",
          // Fixed dates: the same files always snapshot to the same commit.
          GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
          GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
        };
        const label = "Could not snapshot the T3 Code checkout";
        yield* gitOrFail(source.dir, ["add", "--all"], "source", label, { env });
        const tree = (yield* gitOrFail(source.dir, ["write-tree"], "source", label, {
          env,
        })).trim();
        return (yield* gitOrFail(
          source.dir,
          ["commit-tree", tree, "-p", head, "-m", "T3 Code mod base"],
          "source",
          label,
          { env },
        )).trim();
      }),
    );
  });

  // Beside the checkout: installs hardlink from one package store only within a filesystem.
  const worktreesRoot = (source: ModSource) =>
    path.join(path.dirname(source.dir), `${path.basename(source.dir)}${SOURCE_WORKTREES_SUFFIX}`);

  const ensureWorktree = Effect.fn("ModService.ensureWorktree")(function* (
    source: ModSource,
    dir: string,
    commit: string,
  ) {
    if (yield* exists(path.join(dir, ".git"))) return false;
    yield* fs
      .makeDirectory(path.dirname(dir), { recursive: true })
      .pipe(Effect.mapError(failAs("storage", "Could not create the mod checkout folder.")));
    yield* git(source.dir, ["worktree", "prune"]);
    yield* gitOrFail(
      source.dir,
      ["worktree", "add", "--detach", dir, commit],
      "source",
      "Could not create a checkout of T3 Code's source",
      { timeout: Duration.minutes(10) },
    );
    return true;
  });

  const defaultBuilder: ModBuilder = {
    install: Effect.fn("ModService.installDependencies")(function* (input) {
      const args = ["install", "--frozen-lockfile", "--prefer-offline"];
      const installers = [
        { command: "vp", args },
        { command: "pnpm", args },
        { command: "corepack", args: ["pnpm", ...args] },
      ];
      for (const installer of installers) {
        const step = yield* runStep({
          stage: "build",
          label: "Installing dependencies",
          ...installer,
          cwd: input.worktreeDir,
          env: input.env,
          logPath: input.logPath,
          timeout: Duration.minutes(20),
        }).pipe(Effect.option);
        // A spawn failure means this tool is not installed; try the next one.
        if (Option.isNone(step)) continue;
        if (step.value.passed) return;
        return yield* new ModServiceError({
          stage: "build",
          reason: describeFailure("Could not install T3 Code's dependencies", step.value),
        });
      }
      return yield* new ModServiceError({
        stage: "build",
        reason: "Building a customization needs Node.js and pnpm on this machine's PATH.",
      });
    }),
    bundle: Effect.fn("ModService.bundle")(function* (input) {
      const serverDist = path.join(input.worktreeDir, "apps", "server", "dist");
      const webDist = path.join(input.worktreeDir, "apps", "web", "dist");
      // The server build copies the client over its last output, so stale assets would pile up.
      yield* Effect.all([
        fs.remove(serverDist, { recursive: true, force: true }),
        fs.remove(webDist, { recursive: true, force: true }),
      ]).pipe(Effect.ignore);

      const step = yield* runStep({
        stage: "build",
        label: "Building T3 Code",
        command: "vp",
        args: [
          "run",
          "--filter",
          "@t3tools/web",
          ...(input.clientOnly ? [] : ["--filter", "t3"]),
          "build",
        ],
        cwd: input.worktreeDir,
        env: input.env,
        logPath: input.logPath,
        timeout: Duration.minutes(20),
      }).pipe(Effect.mapError(failAs("build", "Could not start the T3 Code build.")));
      if (!step.passed) {
        return yield* new ModServiceError({
          stage: "build",
          reason: describeFailure("The patched T3 Code did not build", step),
        });
      }

      const builtClientDir = input.clientOnly ? webDist : path.join(serverDist, "client");
      const installedClientDir = config.staticDir;
      if (installedClientDir !== undefined) {
        yield* Effect.forEach(
          CLIENT_ICON_FILES,
          (file) =>
            fs.readFile(path.join(installedClientDir, file)).pipe(
              Effect.flatMap((icon) => fs.writeFile(path.join(builtClientDir, file), icon)),
              Effect.ignore,
            ),
          { discard: true },
        );
      }

      const targetDist = path.join(input.buildDir, "dist");
      const clientAssetsDir = path.join(targetDist, "client");
      const storeFailed = failAs("build", "Could not store the built candidate.");
      if (input.clientOnly) {
        yield* fs
          .makeDirectory(targetDist, { recursive: true })
          .pipe(Effect.andThen(fs.copy(webDist, clientAssetsDir)), Effect.mapError(storeFailed));
        return { clientAssetsDir };
      }

      // The process monitor is a native helper that ships beside the server, not in its build.
      const installedMonitorDir = path.join(
        claimedRuntimeOverride()?.stockDir ?? import.meta.dirname,
        "resource-monitor",
      );
      if (yield* exists(installedMonitorDir)) {
        yield* fs
          .copy(installedMonitorDir, path.join(serverDist, "resource-monitor"))
          .pipe(Effect.ignore);
      }

      yield* fs.makeDirectory(input.buildDir, { recursive: true }).pipe(
        Effect.andThen(fs.copy(serverDist, targetDist)),
        // The bundle leaves native packages out. It loads the ones its own source was installed
        // with, which also covers the workers and helper processes it starts from this folder.
        Effect.andThen(
          fs.symlink(
            path.join(input.worktreeDir, "apps", "server", "node_modules"),
            path.join(input.buildDir, "node_modules"),
          ),
        ),
        Effect.mapError(storeFailed),
      );
      return { entryPath: path.join(targetDist, CUSTOM_BUILD_ENTRY), clientAssetsDir };
    }),
  };

  const stepEnv = (worktreeDir: string, sandboxHome: string): NodeJS.ProcessEnv => {
    const env = sanitizedModEnv(hostEnv, sandboxHome);
    return {
      ...env,
      // The checkout's own toolchain wins over whatever is installed globally.
      PATH: [path.join(worktreeDir, "node_modules", ".bin"), env.PATH ?? ""].join(pathDelimiter),
      // A candidate reports the version it replaces, whatever the checkout's manifests say.
      APP_VERSION: currentVersion,
      T3CODE_SOURCE_REPOSITORY: SOURCE_REPOSITORY,
    };
  };

  const ensureDependencies = Effect.fn("ModService.ensureDependencies")(function* (input: {
    readonly worktreeDir: string;
    readonly env: NodeJS.ProcessEnv;
    readonly builder: ModBuilder;
    readonly logPath: string;
  }) {
    const lockfile = yield* fs
      .readFileString(path.join(input.worktreeDir, "pnpm-lock.yaml"))
      .pipe(Effect.option);
    if (Option.isNone(lockfile)) return;
    const stampPath = path.join(input.worktreeDir, "node_modules", ".t3-mod-lockfile");
    const lockSha = computeTextSha256(lockfile.value);
    const installed = yield* fs.readFileString(stampPath).pipe(Effect.option);
    if (Option.isSome(installed) && installed.value === lockSha) return;
    yield* input.builder.install({
      worktreeDir: input.worktreeDir,
      env: input.env,
      logPath: input.logPath,
    });
    yield* fs.writeFileString(stampPath, lockSha).pipe(Effect.ignore);
  });

  const runVerify = Effect.fn("ModService.runVerify")(function* (input: {
    readonly worktreeDir: string;
    readonly verifySource: string;
    readonly verifyPath: string;
    readonly env: NodeJS.ProcessEnv;
    readonly logPath: string;
  }) {
    const verifyFilePath = path.join(input.worktreeDir, input.verifyPath);
    yield* fs
      .makeDirectory(path.dirname(verifyFilePath), { recursive: true })
      .pipe(
        Effect.andThen(fs.writeFileString(verifyFilePath, input.verifySource)),
        Effect.mapError(failAs("verify", "Could not write the check into the build checkout.")),
      );

    // A test file runs under its package's own test config; anything else is a plain script.
    const packageDir = isTestFilePath(input.verifyPath)
      ? yield* findAncestor(path.dirname(verifyFilePath), (dir) =>
          exists(path.join(dir, "package.json")),
        )
      : Option.none<string>();
    const invocation = Option.match(packageDir, {
      onNone: () => ({
        command: nodeCommand,
        args: ["--experimental-strip-types", verifyFilePath],
        cwd: input.worktreeDir,
      }),
      onSome: (dir) => ({
        command: "vp",
        args: ["test", "run", path.relative(dir, verifyFilePath)],
        cwd: dir,
      }),
    });

    return yield* runStep({
      stage: "verify",
      label: "The check",
      ...invocation,
      env: input.env,
      logPath: input.logPath,
      timeout: Duration.minutes(5),
    }).pipe(
      Effect.ensuring(fs.remove(verifyFilePath, { force: true }).pipe(Effect.ignore)),
      Effect.mapError(failAs("verify", "Could not run the check.")),
    );
  });

  const applyPatch = (worktreeDir: string, patchDiff: string) =>
    git(worktreeDir, ["apply", "--3way", "--whitespace=nowarn", "-"], { stdin: patchDiff });

  /** Applies a patch in the build checkout, or leaves the checkout exactly as it was. */
  const applyOrRestore = Effect.fn("ModService.applyOrRestore")(function* (
    worktreeDir: string,
    patchDiff: string,
  ) {
    const applied = yield* applyPatch(worktreeDir, patchDiff);
    if (applied.ok) {
      // A commit per patch is the restore point for the next one.
      yield* git(worktreeDir, ["add", "--all"]);
      yield* git(worktreeDir, [
        "-c",
        "user.name=T3 Code",
        "-c",
        "user.email=mods@t3.codes",
        "commit",
        "--quiet",
        "--no-verify",
        "--allow-empty",
        "-m",
        "mod",
      ]);
      return applied;
    }
    // A failed three-way apply leaves conflict markers behind.
    yield* git(worktreeDir, ["reset", "--hard"]);
    yield* git(worktreeDir, ["clean", "-fd"]);
    return applied;
  });

  const readModDir = Effect.fn("ModService.readModDir")(function* (dirPath: string) {
    const rawMeta = yield* fs
      .readFileString(path.join(dirPath, MOD_METADATA_FILE))
      .pipe(Effect.option);
    if (Option.isNone(rawMeta)) return Option.none<SavedModRecord>();
    const metadataOpt = decodeSavedModMetadata(rawMeta.value);
    if (Option.isNone(metadataOpt)) return Option.none<SavedModRecord>();

    const [intent, verifySource, patchDiff] = yield* Effect.all([
      fs.readFileString(path.join(dirPath, MOD_INTENT_FILE)).pipe(Effect.orElseSucceed(() => "")),
      fs.readFileString(path.join(dirPath, MOD_VERIFY_FILE)).pipe(Effect.orElseSucceed(() => "")),
      fs.readFileString(path.join(dirPath, MOD_PATCH_FILE)).pipe(Effect.orElseSucceed(() => "")),
    ]);

    return Option.some<SavedModRecord>({
      metadata: metadataOpt.value,
      intent,
      verifySource,
      patchDiff,
      dirPath,
      verifyTampered: computeTextSha256(verifySource) !== metadataOpt.value.verifySha256,
    });
  });

  const listMods: ModService["Service"]["listMods"] = Effect.fn("ModService.listMods")(
    function* () {
      if (!(yield* exists(paths.patchesDir))) return [];
      const entries = yield* fs
        .readDirectory(paths.patchesDir)
        .pipe(Effect.mapError(failAs("storage", "Failed to list saved mods.")));
      const records: Array<SavedModRecord> = [];
      for (const entry of entries.toSorted()) {
        const mod = yield* readModDir(path.join(paths.patchesDir, entry));
        if (Option.isSome(mod)) records.push(mod.value);
      }
      // Mods stack in the order they were made, so a later one can build on an earlier one.
      return records.toSorted(
        (left, right) =>
          left.metadata.createdAt.localeCompare(right.metadata.createdAt) ||
          left.metadata.id.localeCompare(right.metadata.id),
      );
    },
  );

  const status: ModService["Service"]["status"] = Effect.fn("ModService.status")(function* () {
    const mods = yield* listMods();
    const activeOverride = readRuntimeOverridePointer(config.stateDir);
    const fallback = readRuntimeOverrideFallback(config.stateDir);
    return {
      currentVersion,
      activeOverride,
      fallback,
      mods,
      paused:
        activeOverride === null && fallback?.reason === "version_mismatch"
          ? mods.filter((mod) => mod.metadata.enabled)
          : [],
      rebuilding: yield* Ref.get(rebuilding),
      rebuildFailure: yield* Ref.get(rebuildFailure),
    };
  });

  /** The user's other mods, split around where this one sits in the stack. A new mod is last. */
  const otherModsAround = Effect.fn("ModService.otherModsAround")(function* (id: string) {
    const mods = (yield* listMods()).filter((mod) => mod.metadata.enabled);
    const index = mods.findIndex((mod) => mod.metadata.id === id);
    return index === -1
      ? { earlier: mods, later: [] }
      : { earlier: mods.slice(0, index), later: mods.slice(index + 1) };
  });

  const saveModFiles = Effect.fn("ModService.saveModFiles")(function* (input: {
    readonly dirPath: string;
    readonly id: string;
    readonly title: string;
    readonly intent: string;
    readonly verifySource: string;
    readonly verifyPath: string;
    readonly patchDiff: string;
    readonly verifySha256: string;
    readonly baseVersion: string;
    readonly enabled: boolean;
    readonly needsRepair?: boolean;
  }) {
    const existing = yield* readModDir(input.dirPath);
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const metadata: SavedModMetadata = {
      schemaVersion: 1,
      id: input.id,
      title: input.title,
      baseVersion: input.baseVersion,
      enabled: input.enabled,
      verifySha256: input.verifySha256,
      verifyPath: input.verifyPath,
      ...(input.needsRepair === true ? { needsRepair: true } : {}),
      createdAt: Option.isSome(existing) ? existing.value.metadata.createdAt : nowIso,
      updatedAt: nowIso,
    };
    const encodedMeta = yield* encodeSavedModMetadata(metadata).pipe(
      Effect.mapError(failAs("storage", "Failed to encode mod metadata.")),
    );
    yield* fs
      .makeDirectory(input.dirPath, { recursive: true })
      .pipe(
        Effect.andThen(
          Effect.all([
            fs.writeFileString(path.join(input.dirPath, MOD_METADATA_FILE), `${encodedMeta}\n`),
            fs.writeFileString(path.join(input.dirPath, MOD_INTENT_FILE), input.intent),
            fs.writeFileString(path.join(input.dirPath, MOD_VERIFY_FILE), input.verifySource),
            fs.writeFileString(path.join(input.dirPath, MOD_PATCH_FILE), input.patchDiff),
          ]),
        ),
        Effect.mapError(failAs("storage", "Failed to save the mod.")),
      );
    return { metadata, dirPath: input.dirPath };
  });

  /** Saves an approved mod again as it is, apart from `changes`. */
  const resaveMod = (
    mod: SavedModRecord,
    changes: {
      readonly enabled: boolean;
      readonly baseVersion?: string;
      readonly needsRepair?: boolean;
    },
  ) =>
    saveModFiles({
      dirPath: path.join(paths.patchesDir, mod.metadata.id),
      id: mod.metadata.id,
      title: mod.metadata.title,
      intent: mod.intent,
      verifySource: mod.verifySource,
      verifyPath: mod.metadata.verifyPath ?? VERIFY_SCRIPT_FILENAME,
      patchDiff: mod.patchDiff,
      verifySha256: mod.metadata.verifySha256,
      baseVersion: mod.metadata.baseVersion,
      ...changes,
    });

  /** Makes `build` the one this T3 Code runs: its interface at once, its server from the next start. */
  const pointTo = Effect.fn("ModService.pointTo")(function* (build: {
    readonly buildId: string;
    readonly baseVersion: string;
    readonly artifactSha256: string;
    readonly entryPath?: string | undefined;
    readonly clientAssetsDir: string;
    readonly mods: ReadonlyArray<RuntimeOverrideModSummary>;
  }) {
    writeRuntimeOverridePointer(config.stateDir, {
      schemaVersion: 1,
      buildId: build.buildId,
      baseVersion: build.baseVersion,
      artifactSha256: build.artifactSha256,
      // Only a build with its own server has a start that can fail.
      ...(build.entryPath !== undefined ? { entryPath: build.entryPath, pendingTrial: true } : {}),
      clientAssetsDir: build.clientAssetsDir,
      mods: build.mods.map(({ id, title, verifySha256 }) => ({ id, title, verifySha256 })),
      activatedAt: DateTime.formatIso(yield* DateTime.now),
    });
    clearRuntimeOverrideFallback(config.stateDir);
  });

  const readManifest = Effect.fn("ModService.readManifest")(function* (buildId: string) {
    const raw = BUILD_ID_PATTERN.test(buildId)
      ? yield* fs
          .readFileString(path.join(paths.buildsDir, buildId, BUILD_MANIFEST_FILE))
          .pipe(Effect.option)
      : Option.none<string>();
    if (Option.isNone(raw)) {
      return yield* new ModServiceError({
        stage: "build",
        activation: "build_missing",
        reason: `Candidate build "${buildId}" does not exist.`,
      });
    }
    const decoded = decodeBuildManifest(raw.value);
    if (Option.isNone(decoded)) {
      return yield* new ModServiceError({
        stage: "build",
        reason: `Candidate build "${buildId}" has an unreadable manifest.`,
      });
    }
    return decoded.value;
  });

  const removeBuild = Effect.fn("ModService.removeBuild")(function* (buildId: string) {
    if (readRuntimeOverridePointer(config.stateDir)?.buildId === buildId) return;
    const preview = yield* Ref.get(activePreviewRef);
    if (Option.isSome(preview) && preview.value.buildId === buildId) yield* stopActivePreview();
    yield* fs
      .remove(path.join(paths.buildsDir, buildId), { recursive: true, force: true })
      .pipe(Effect.ignore);
  });

  /** Resets one of the shared build checkouts to stock, with dependencies installed. */
  const prepareBuildCheckout = Effect.fn("ModService.prepareBuildCheckout")(function* (input: {
    readonly name: typeof BUILD_CHECKOUT_NAME | typeof CHECK_CHECKOUT_NAME;
    readonly source: ModSource;
    readonly baseCommit: string;
    readonly builder: ModBuilder;
    readonly logPrefix: string;
  }) {
    const worktreeDir = path.join(worktreesRoot(input.source), input.name);
    yield* ensureWorktree(input.source, worktreeDir, input.baseCommit);
    yield* gitOrFail(
      worktreeDir,
      ["reset", "--hard", input.baseCommit],
      "source",
      "Could not reset the build checkout",
    );
    yield* gitOrFail(worktreeDir, ["clean", "-fd"], "source", "Could not reset the build checkout");

    // Sign-in and relay settings are baked in at build time from an untracked .env. Official
    // builds bake the public values in .env.example, so a candidate of one keeps them.
    const publicEnv = yield* fs
      .readFileString(path.join(input.source.dir, ".env"))
      .pipe(Effect.option);
    const bakedEnv =
      Option.isSome(publicEnv) || !hasCloudPublicConfig
        ? publicEnv
        : yield* fs.readFileString(path.join(worktreeDir, ".env.example")).pipe(Effect.option);
    yield* Option.match(bakedEnv, {
      onNone: () => fs.remove(path.join(worktreeDir, ".env"), { force: true }),
      onSome: (contents) => fs.writeFileString(path.join(worktreeDir, ".env"), contents),
    }).pipe(Effect.ignore);
    const sandboxHome = yield* fs
      .makeTempDirectoryScoped({ prefix: "t3-mod-sandbox-" })
      .pipe(Effect.mapError(failAs("storage", "Could not create a scratch home for the build.")));
    const env = stepEnv(worktreeDir, sandboxHome);
    const installDependencies = () =>
      ensureDependencies({
        worktreeDir,
        env,
        builder: input.builder,
        logPath: `${input.logPrefix}-install${input.name}.log`,
      });
    yield* installDependencies();
    return { worktreeDir, env, installDependencies };
  });

  const workspaceDirFor = (source: ModSource, id: string) => path.join(worktreesRoot(source), id);

  const startWorkspace: ModService["Service"]["startWorkspace"] = Effect.fn(
    "ModService.startWorkspace",
  )(function* (input) {
    if (!isValidModId(input.id)) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: `Invalid mod id "${input.id}". Use lowercase letters, digits, and hyphens.`,
      });
    }
    const source = yield* resolveSource(input.sourceDir);
    const baseCommit = yield* resolveBaseCommit(source);
    const workspaceDir = workspaceDirFor(source, input.id);

    if (input.reset === true && (yield* exists(workspaceDir))) {
      yield* git(source.dir, ["worktree", "remove", "--force", workspaceDir]);
      yield* fs.remove(workspaceDir, { recursive: true, force: true }).pipe(Effect.ignore);
    }

    const created = yield* ensureWorktree(source, workspaceDir, baseCommit);
    // The workspace is T3 Code as the user has it, earlier mods included: a change next to one
    // of theirs is then written against it, and the diff from this base is still this mod alone.
    const { earlier } = yield* otherModsAround(input.id);
    const builtOn = earlier.map((mod) => ({ id: mod.metadata.id, title: mod.metadata.title }));
    if (!created) {
      const workspaceStock = yield* git(workspaceDir, ["rev-parse", WORKSPACE_STOCK_REF]);
      return {
        workspaceDir,
        created: false,
        baseOutdated: workspaceStock.stdout.trim() !== baseCommit,
        savedPatch: "kept" as const,
        builtOn,
      };
    }

    yield* Effect.forEach(earlier, (mod) => applyOrRestore(workspaceDir, mod.patchDiff), {
      discard: true,
    });
    yield* Effect.forEach(
      [
        [WORKSPACE_STOCK_REF, baseCommit],
        [WORKSPACE_BASE_REF, "HEAD"],
      ] as const,
      ([ref, target]) =>
        gitOrFail(
          workspaceDir,
          ["update-ref", ref, target],
          "source",
          "Could not prepare the mod workspace",
        ),
      { discard: true },
    );
    const saved = yield* readModDir(path.join(paths.patchesDir, input.id));
    const savedPatch = Option.isNone(saved)
      ? ("none" as const)
      : (yield* applyPatch(workspaceDir, saved.value.patchDiff)).ok
        ? ("applied" as const)
        : ("conflicted" as const);

    yield* Effect.scoped(
      Effect.gen(function* () {
        const sandboxHome = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-mod-sandbox-" })
          .pipe(Effect.mapError(failAs("storage", "Could not create a scratch home.")));
        yield* ensureDependencies({
          worktreeDir: workspaceDir,
          env: stepEnv(workspaceDir, sandboxHome),
          builder: input.builder ?? defaultBuilder,
          logPath: path.join(paths.logsDir, `${input.id}-workspace-install.log`),
        });
      }),
    );
    return { workspaceDir, created: true, baseOutdated: false, savedPatch, builtOn };
  });

  const readWorkspacePatch = Effect.fn("ModService.readWorkspacePatch")(function* (
    source: ModSource,
    id: string,
  ) {
    const workspaceDir = workspaceDirFor(source, id);
    const base = yield* git(workspaceDir, ["rev-parse", WORKSPACE_BASE_REF]).pipe(
      Effect.orElseSucceed(() => ({ ok: false, stdout: "", output: "" })),
    );
    if (!base.ok) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: `Mod "${id}" has no workspace. Call t3_mod_start first and make the change there.`,
      });
    }
    const label = "Could not read the changes in the mod workspace";
    // Staging is how new files get into the diff; commits the agent made are covered by the base.
    yield* gitOrFail(workspaceDir, ["add", "--all"], "patch", label);
    return yield* gitOrFail(
      workspaceDir,
      ["diff", "--cached", "--binary", "--no-color", base.stdout.trim()],
      "patch",
      label,
    );
  });

  const prepareCandidate: ModService["Service"]["prepareCandidate"] = Effect.fn(
    "ModService.prepareCandidate",
  )(function* (input) {
    if (!isValidModId(input.id)) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: `Invalid mod id "${input.id}". Use lowercase letters, digits, and hyphens.`,
      });
    }
    if (input.title.trim().length === 0 || input.intent.trim().length === 0) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: "A customization requires both a non-empty title and intent.",
      });
    }
    if (input.verifySource.trim().length === 0) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: "A customization requires a check that fails without it.",
      });
    }
    const verifyPath = input.verifyPath?.trim() || VERIFY_SCRIPT_FILENAME;
    if (!isSafeVerifyPath(verifyPath)) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: `verifyPath "${verifyPath}" must be a .ts or .tsx path inside the repository.`,
      });
    }

    const source = yield* resolveSource(input.sourceDir);
    const patchDiff = yield* readWorkspacePatch(source, input.id);
    if (patchDiff.trim().length === 0) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: "The mod workspace has no changes yet.",
      });
    }
    const guardrails = checkPatchGuardrails(patchDiff);
    if (guardrails.blocked.length > 0) {
      return yield* new ModServiceError({
        stage: "guardrail",
        reason: guardrails.blocked.join(" "),
      });
    }
    if (guardrails.files.includes(verifyPath)) {
      return yield* new ModServiceError({
        stage: "validation",
        reason: `verifyPath is where the check script is saved while it runs, and ${verifyPath} is a file the change touches. Omit verifyPath, or name a new file.`,
      });
    }

    const baseCommit = yield* resolveBaseCommit(source);
    const shortId = (yield* random.uuidV4()).replaceAll("-", "").slice(0, 12);
    const buildId = `${input.id}-${shortId}`;
    const buildDir = path.join(paths.buildsDir, buildId);
    const logPrefix = path.join(paths.logsDir, buildId);
    const verifySha256 = computeTextSha256(input.verifySource);
    const builder = input.builder ?? defaultBuilder;
    // Every other approved mod stays in the build, or applying this one would drop them.
    const stack = yield* otherModsAround(input.id);
    const otherMods = [...stack.earlier, ...stack.later];

    // A newer proposal for the same mod replaces the builds of its earlier ones.
    const earlierBuilds = yield* fs
      .readDirectory(paths.buildsDir)
      .pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      earlierBuilds,
      (entry) =>
        readManifest(entry).pipe(
          Effect.flatMap((manifest) =>
            manifest.proposedModId === input.id ? removeBuild(entry) : Effect.void,
          ),
          Effect.ignore,
        ),
      { discard: true },
    );

    const { stockFailed, includedMods, entryPath, clientAssetsDir } = yield* buildLock.withPermits(
      1,
    )(
      Effect.scoped(
        Effect.gen(function* () {
          const checkout = yield* prepareBuildCheckout({
            name: BUILD_CHECKOUT_NAME,
            source,
            baseCommit,
            builder,
            logPrefix,
          });
          // After an update a saved mod may not apply any more. It is left out, not a dead end:
          // the user sees that on the card, and repairs it as its own proposal afterwards.
          const applyAll = Effect.fn("ModService.applyAll")(function* (
            worktreeDir: string,
            mods: ReadonlyArray<SavedModRecord>,
          ) {
            const applied: Array<SavedModRecord> = [];
            for (const mod of mods) {
              if ((yield* applyOrRestore(worktreeDir, mod.patchDiff)).ok) applied.push(mod);
            }
            return applied;
          });
          const includedEarlier = yield* applyAll(checkout.worktreeDir, stack.earlier);
          const applied = yield* applyOrRestore(checkout.worktreeDir, patchDiff);
          if (!applied.ok) {
            return yield* new ModServiceError({
              stage: "patch",
              reason: `The change does not apply on top of your other mods (${includedEarlier.map((mod) => mod.metadata.id).join(", ") || "none"}). Call t3_mod_start with reset to rebuild the workspace on top of them: ${applied.output}`,
            });
          }
          const includedMods = [
            ...includedEarlier,
            ...(yield* applyAll(checkout.worktreeDir, stack.later)),
          ];
          const clientOnly =
            isClientOnlyChange(guardrails.files) &&
            includedMods.every((mod) =>
              isClientOnlyChange(checkPatchGuardrails(mod.patchDiff).files),
            );
          yield* checkout.installDependencies();

          // The check runs without the change and then with it, in a checkout of its own: that
          // takes about as long as the build, and the check file must not end up in the build.
          const checks = Effect.gen(function* () {
            const checked = yield* prepareBuildCheckout({
              name: CHECK_CHECKOUT_NAME,
              source,
              baseCommit,
              builder,
              logPrefix,
            });
            const runCheck = (label: "stock" | "candidate") =>
              runVerify({
                worktreeDir: checked.worktreeDir,
                verifySource: input.verifySource,
                verifyPath,
                env: checked.env,
                logPath: `${logPrefix}-verify-${label}.log`,
              });
            yield* applyAll(checked.worktreeDir, includedEarlier);
            const stockRun = yield* runCheck("stock");
            yield* applyOrRestore(checked.worktreeDir, patchDiff);
            yield* checked.installDependencies();
            const candidateRun = yield* runCheck("candidate");
            if (!candidateRun.passed) {
              return yield* new ModServiceError({
                stage: "verify",
                reason: describeFailure("The check failed with the change applied", candidateRun),
              });
            }
            return stockRun;
          });
          const bundle = builder.bundle({
            worktreeDir: checkout.worktreeDir,
            buildDir,
            clientOnly,
            env: checkout.env,
            logPath: `${logPrefix}-build.log`,
          });

          // Each runs to its end: a build tool cut off mid-run leaves children writing here.
          const [stock, built] = yield* Effect.all([Effect.exit(checks), Effect.exit(bundle)], {
            concurrency: 2,
          });
          const stockRun = yield* stock;
          return { ...(yield* built), stockFailed: !stockRun.passed, includedMods };
        }),
      ).pipe(
        // A check or build that failed leaves a half-written candidate behind.
        Effect.tapError(() => removeBuild(buildId).pipe(Effect.ignore)),
      ),
    );

    const artifactSha256 = computeRuntimeOverrideArtifactSha256(entryPath, clientAssetsDir);
    if (artifactSha256 === null) {
      return yield* new ModServiceError({
        stage: "build",
        reason: "Built candidate is missing server entry or client index.html.",
      });
    }
    const skippedMods = otherMods.filter((mod) => !includedMods.includes(mod));

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const manifestEncoded = yield* encodeBuildManifest({
      schemaVersion: 1,
      buildId,
      baseVersion: currentVersion,
      artifactSha256,
      ...(entryPath !== undefined ? { entryPath } : {}),
      clientAssetsDir,
      proposedModId: input.id,
      sourceDir: source.dir,
      workspaceDir: workspaceDirFor(source, input.id),
      skippedModIds: skippedMods.map((mod) => mod.metadata.id),
      mods: [
        ...includedMods.map((mod) => ({
          id: mod.metadata.id,
          title: mod.metadata.title,
          verifySha256: mod.metadata.verifySha256,
          patchSha256: computeTextSha256(mod.patchDiff),
        })),
        {
          id: input.id,
          title: input.title,
          verifySha256,
          patchSha256: computeTextSha256(patchDiff),
        },
      ],
      createdAt: nowIso,
    }).pipe(Effect.mapError(failAs("build", "Failed to encode build manifest.")));
    yield* fs
      .writeFileString(path.join(buildDir, BUILD_MANIFEST_FILE), `${manifestEncoded}\n`)
      .pipe(Effect.mapError(failAs("build", "Failed to write build manifest.")));

    // The mod is saved with its build and only joins the approved mods when the user applies it.
    yield* saveModFiles({
      dirPath: path.join(buildDir, BUILD_PROPOSED_MOD_DIR),
      id: input.id,
      title: input.title,
      intent: input.intent,
      verifySource: input.verifySource,
      verifyPath,
      patchDiff,
      verifySha256,
      baseVersion: currentVersion,
      enabled: true,
    });

    const { diffPreview, diffTruncated } = truncateDiff(patchDiff);
    return {
      modId: input.id,
      title: input.title,
      intent: input.intent,
      baseVersion: currentVersion,
      buildId,
      artifactSha256,
      verifySha256,
      files: [...guardrails.files],
      diffPreview,
      diffTruncated,
      warnings: [
        ...skippedMods.map(
          (mod) =>
            `Your mod "${mod.metadata.title}" no longer fits this T3 Code version. It is not in this build, and applying turns it off until it is repaired.`,
        ),
        ...guardrails.warnings,
        ...(stockFailed
          ? []
          : [
              "The check already passed before the change was applied, so it does not prove the change works.",
            ]),
      ],
      verification: {
        stockFailed,
        candidatePassed: true,
        summary: stockFailed
          ? "The check failed on your current T3 Code and passed with the change."
          : "The check passed with and without the change.",
      },
      restartRequired: entryPath !== undefined || runsCustomServer,
    } satisfies ModApprovalPreview;
  });

  const previewCandidate: ModService["Service"]["previewCandidate"] = Effect.fn(
    "ModService.previewCandidate",
  )(function* ({ buildId }) {
    const manifest = yield* readManifest(buildId);
    // A pairing link works once, so every preview is a fresh server with a fresh link.
    yield* stopActivePreview();

    const port = yield* net
      .reserveLoopbackPort()
      .pipe(Effect.mapError(failAs("preview", "Could not find a free port for the preview.")));
    const previewScope = yield* Scope.fork(serviceScope, "sequential");
    const start = Effect.gen(function* () {
      const sandboxHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mod-preview-" });
      const child = yield* spawner.spawn(
        ChildProcess.make(
          stockCommand[0]!,
          [
            ...stockCommand.slice(1),
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            String(port),
            "--base-dir",
            sandboxHome,
            "--no-browser",
          ],
          {
            env: {
              ...sanitizedModEnv(hostEnv, sandboxHome),
              ...(manifest.entryPath === undefined
                ? // The stock server, showing the candidate's client.
                  { [RUNTIME_OVERRIDE_ENV_STATIC_DIR]: manifest.clientAssetsDir }
                : runtimeOverrideEnv(manifest)),
            },
            extendEnv: false,
            stdout: "pipe",
            stderr: "pipe",
          },
        ),
      );
      const pairingUrl = yield* Deferred.make<string>();
      // Keep reading after the link is found, or a full pipe stalls the preview server.
      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const match = PAIRING_URL_PATTERN.exec(line);
          return match?.[1] ? Deferred.succeed(pairingUrl, match[1]) : Effect.void;
        }),
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkScoped);
      return pairingUrl;
    }).pipe(
      Scope.provide(previewScope),
      Effect.mapError(failAs("preview", "Could not start the preview server.")),
    );

    const previewUrl = yield* start.pipe(
      Effect.tap(() =>
        waitForHttpReady({
          baseUrl: `http://127.0.0.1:${port}`,
          path: "/.well-known/t3/environment",
          timeoutMs: 60_000,
          intervalMs: 150,
          probeTimeoutMs: 1_000,
          makeError: ({ cause }) =>
            new ModServiceError({
              stage: "preview",
              reason: "The preview server did not start in time.",
              cause,
            }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      ),
      Effect.flatMap((pairingUrl) =>
        Deferred.await(pairingUrl).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(30),
            orElse: () =>
              Effect.fail(
                new ModServiceError({
                  stage: "preview",
                  reason: "The preview server started without a sign-in link.",
                }),
              ),
          }),
        ),
      ),
      Effect.tapError(() => closeScope(previewScope)),
    );

    yield* Ref.set(activePreviewRef, Option.some({ buildId, scope: previewScope }));
    return { previewUrl };
  });

  const setModEnabled: ModService["Service"]["setModEnabled"] = Effect.fn(
    "ModService.setModEnabled",
  )(function* ({ id, enabled }) {
    const dirPath = path.join(paths.patchesDir, id);
    const existing = isValidModId(id) ? yield* readModDir(dirPath) : Option.none<SavedModRecord>();
    if (Option.isNone(existing)) {
      return yield* new ModServiceError({
        stage: "storage",
        reason: `Mod "${id}" was not found.`,
      });
    }
    yield* resaveMod(existing.value, { enabled });
  });

  const activateBuild: ModService["Service"]["activateBuild"] = Effect.fn(
    "ModService.activateBuild",
  )(function* ({ buildId, expectedArtifactSha256 }) {
    if (config.devUrl !== undefined) {
      return yield* new ModServiceError({
        stage: "activate",
        activation: "dev_server",
        reason: "A dev server runs from source, so there is no installed T3 Code to replace.",
      });
    }
    const manifest = yield* readManifest(buildId);
    if (manifest.baseVersion !== currentVersion) {
      return yield* new ModServiceError({
        stage: "activate",
        reason: `Candidate build targets ${manifest.baseVersion}, but this T3 Code version is ${currentVersion}.`,
      });
    }
    const actualSha = computeRuntimeOverrideArtifactSha256(
      manifest.entryPath,
      manifest.clientAssetsDir,
    );
    if (
      actualSha === null ||
      actualSha !== manifest.artifactSha256 ||
      actualSha !== expectedArtifactSha256
    ) {
      return yield* new ModServiceError({
        stage: "activate",
        activation: "artifact_mismatch",
        reason:
          "Candidate artifact digest did not match the approved build. Rebuild and approve again.",
      });
    }
    const proposed = yield* readModDir(path.join(paths.buildsDir, buildId, BUILD_PROPOSED_MOD_DIR));
    if (Option.isNone(proposed)) {
      return yield* new ModServiceError({
        stage: "build",
        reason: `Candidate build "${buildId}" lost its mod files.`,
      });
    }

    // A build made before another mod was applied or edited would silently undo that mod.
    const builtWith = manifest.mods
      .filter((mod) => mod.id !== manifest.proposedModId)
      .map((mod) => `${mod.id}:${mod.patchSha256}`);
    const approved = (yield* listMods())
      .filter(
        (mod) =>
          mod.metadata.enabled &&
          mod.metadata.id !== manifest.proposedModId &&
          !manifest.skippedModIds.includes(mod.metadata.id),
      )
      .map((mod) => `${mod.metadata.id}:${computeTextSha256(mod.patchDiff)}`);
    if (builtWith.toSorted().join("\n") !== approved.toSorted().join("\n")) {
      return yield* new ModServiceError({
        stage: "activate",
        activation: "stale_build",
        reason: "Your mods changed after this build was made. Ask the agent to propose it again.",
      });
    }

    yield* stopActivePreview();
    yield* Effect.forEach(
      manifest.skippedModIds,
      (id) => setModEnabled({ id, enabled: false }).pipe(Effect.ignore),
      { discard: true },
    );
    yield* saveModFiles({
      dirPath: path.join(paths.patchesDir, proposed.value.metadata.id),
      id: proposed.value.metadata.id,
      title: proposed.value.metadata.title,
      intent: proposed.value.intent,
      verifySource: proposed.value.verifySource,
      verifyPath: proposed.value.metadata.verifyPath ?? VERIFY_SCRIPT_FILENAME,
      patchDiff: proposed.value.patchDiff,
      verifySha256: proposed.value.metadata.verifySha256,
      baseVersion: manifest.baseVersion,
      enabled: true,
    });
    yield* pointTo(manifest);

    // Every other build predates this approval, so none of them can be applied any more. The
    // saved mod is the source of truth now, so its workspace goes too. Both hold hundreds of
    // megabytes, and the answer does not wait for them to be deleted.
    const builds = yield* fs.readDirectory(paths.buildsDir).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      builds.filter((entry) => entry !== buildId && BUILD_ID_PATTERN.test(entry)),
      removeBuild,
      { discard: true },
    ).pipe(
      Effect.andThen(
        git(manifest.sourceDir, ["worktree", "remove", "--force", manifest.workspaceDir]),
      ),
      Effect.ignore,
      Effect.forkIn(serviceScope),
    );
    // The stock server serves a client-only build from its next page load on.
    return { restartRequired: manifest.entryPath !== undefined || runsCustomServer };
  });

  const discardCandidate: ModService["Service"]["discardCandidate"] = Effect.fn(
    "ModService.discardCandidate",
  )(function* ({ buildId }) {
    if (BUILD_ID_PATTERN.test(buildId)) yield* removeBuild(buildId);
  });

  const disableAll: ModService["Service"]["disableAll"] = Effect.fn("ModService.disableAll")(
    function* () {
      yield* stopActivePreview();
      const active = readRuntimeOverridePointer(config.stateDir);
      clearRuntimeOverridePointer(config.stateDir);
      clearRuntimeOverrideFallback(config.stateDir);
      // Off stays off: a mod left enabled would ride back in with the next mod's build.
      yield* Effect.forEach(
        yield* listMods(),
        (mod) => setModEnabled({ id: mod.metadata.id, enabled: false }),
        { discard: true },
      );
      return { restartRequired: active?.entryPath !== undefined || runsCustomServer };
    },
  );

  // The installed T3 Code: its own interface, native helper and native packages.
  const stockDir =
    claimedRuntimeOverride()?.stockDir ??
    (NodeSea.isSea() ? path.dirname(hostExecutable) : import.meta.dirname);
  // Vite names these after their contents, so a file with the same name is the same file.
  const isHashedAsset = (file: string) => /^assets\/.+-[\w-]{8}\.[^/]+$/.test(file);
  const clientPools = () =>
    [
      path.join(stockDir, "client"),
      config.staticDir,
      readRuntimeOverridePointer(config.stateDir)?.clientAssetsDir,
    ].filter((dir): dir is string => dir !== undefined);
  const findClientFile = (file: string) =>
    Option.fromNullishOr(
      clientPools()
        .map((pool) => path.join(pool, file))
        .find(installedFileExists),
    );
  const listFiles = Effect.fn("ModService.listFiles")(function* (dir: string) {
    const entries = yield* fs
      .readDirectory(dir, { recursive: true })
      .pipe(Effect.orElseSucceed(() => [] as Array<string>));
    const files: Array<string> = [];
    for (const entry of entries) {
      const info = yield* fs.stat(path.join(dir, entry)).pipe(Effect.orElseSucceed(() => null));
      if (info?.type === "File") files.push(entry.replaceAll("\\", "/"));
    }
    return files.toSorted();
  });
  const readViteFiles = (clientDir: string): ReadonlyArray<string> => {
    const manifest = Option.getOrUndefined(
      decodeViteManifest(readInstalledText(path.join(clientDir, ".vite", "manifest.json"))),
    );
    return manifest === undefined
      ? []
      : Object.values(manifest).flatMap((entry) => [
          entry.file,
          ...(entry.css ?? []),
          ...(entry.assets ?? []),
        ]);
  };

  const describeBuild: ModService["Service"]["describeBuild"] = Effect.fn(
    "ModService.describeBuild",
  )(function* ({ buildId }) {
    const manifest = yield* readManifest(buildId);
    const referenced = new Set(readViteFiles(manifest.clientAssetsDir));
    const clientFiles: Array<string> = [];
    // A build folder can hold hashed files nothing refers to any more; those stay behind.
    for (const file of yield* listFiles(manifest.clientAssetsDir)) {
      if (
        !isHashedAsset(file) ||
        referenced.has(file) ||
        installedFileExists(path.join(stockDir, "client", file))
      ) {
        clientFiles.push(file);
      }
    }
    return {
      buildId,
      baseVersion: manifest.baseVersion,
      artifactSha256: manifest.artifactSha256,
      restartRequired: manifest.entryPath !== undefined,
      clientFiles,
      mods: manifest.mods.map(({ id, title, patchSha256 }) => ({ id, title, patchSha256 })),
    };
  });

  const missingClientFiles: ModService["Service"]["missingClientFiles"] = (files) =>
    Effect.sync(() =>
      files.filter(
        (file) =>
          isSafePackName(file) && (!isHashedAsset(file) || Option.isNone(findClientFile(file))),
      ),
    );

  const packBuild: ModService["Service"]["packBuild"] = Effect.fn("ModService.packBuild")(
    function* ({ buildId, clientFiles, packPath }) {
      const manifest = yield* readManifest(buildId);
      const buildDir = path.join(paths.buildsDir, buildId);
      const offered = new Set((yield* describeBuild({ buildId })).clientFiles);
      const entries: Array<BuildPackEntry> = [
        { name: BUILD_MANIFEST_FILE, filePath: path.join(buildDir, BUILD_MANIFEST_FILE) },
      ];
      if (manifest.entryPath !== undefined) {
        const distDir = path.dirname(manifest.entryPath);
        for (const file of yield* listFiles(distDir)) {
          // The interface is packed below, the native helper is each machine's own, and source
          // maps double the size for a stack trace nobody reads there.
          if (
            file.startsWith("client/") ||
            file.startsWith("resource-monitor/") ||
            file.endsWith(".map")
          ) {
            continue;
          }
          entries.push({ name: `dist/${file}`, filePath: path.join(distDir, file) });
        }
      }
      for (const file of clientFiles) {
        if (!offered.has(file)) continue;
        entries.push({
          name: `dist/client/${file}`,
          filePath: path.join(manifest.clientAssetsDir, file),
        });
      }
      for (const mod of manifest.mods) {
        const saved = path.join(paths.patchesDir, mod.id);
        const modDir = (yield* exists(path.join(saved, MOD_METADATA_FILE)))
          ? saved
          : path.join(buildDir, BUILD_PROPOSED_MOD_DIR);
        for (const file of MOD_FILES) {
          entries.push({ name: `mods/${mod.id}/${file}`, filePath: path.join(modDir, file) });
        }
      }
      yield* Effect.try({
        try: () => writeBuildPack(packPath, entries),
        catch: failAs("storage", "Could not pack the build for another machine."),
      });
    },
  );

  const installBuild: ModService["Service"]["installBuild"] = Effect.fn("ModService.installBuild")(
    function* ({ packPath }) {
      const failed = (reason: string) => failAs("activate", reason);
      const incoming = path.join(paths.buildsDir, `.incoming-${yield* random.uuidV4()}`);
      yield* Effect.addFinalizer(() =>
        fs.remove(incoming, { recursive: true, force: true }).pipe(Effect.ignore),
      );
      yield* Effect.try({
        try: () => readBuildPack(packPath, incoming),
        catch: failed("The build from the other machine arrived damaged."),
      });
      const manifest = yield* fs.readFileString(path.join(incoming, BUILD_MANIFEST_FILE)).pipe(
        Effect.map(decodeBuildManifest),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(manifest) || !BUILD_ID_PATTERN.test(manifest.value.buildId)) {
        return yield* new ModServiceError({
          stage: "activate",
          reason: "The build from the other machine has no readable description.",
        });
      }
      const { buildId } = manifest.value;
      if (manifest.value.baseVersion !== currentVersion) {
        return yield* new ModServiceError({
          stage: "activate",
          reason: `The build is for T3 Code ${manifest.value.baseVersion}, and this machine runs ${currentVersion}.`,
        });
      }
      const buildDir = path.join(paths.buildsDir, buildId);
      const servesItsOwnServer = manifest.value.entryPath !== undefined;
      if (readRuntimeOverridePointer(config.stateDir)?.buildId === buildId) {
        return { buildId, restartRequired: servesItsOwnServer && !runsCustomServer };
      }

      // Files this machine already had were left out of the pack.
      const clientDir = path.join(incoming, "dist", "client");
      const completed = yield* Effect.try({
        try: () => {
          for (const file of [
            ...readViteFiles(clientDir),
            // Files of the installed interface that no build step names, such as its icons.
            ...listInstalledFiles(path.join(stockDir, "client")),
          ]) {
            const target = path.join(clientDir, file);
            if (!isSafePackName(file) || installedFileExists(target)) continue;
            const local = Option.getOrUndefined(findClientFile(file));
            if (local === undefined) return file;
            copyInstalledFile(local, target);
          }
          if (!servesItsOwnServer) return null;
          // The native helper is each machine's own.
          const monitorDir = path.join(stockDir, "resource-monitor");
          for (const file of listInstalledFiles(monitorDir)) {
            copyInstalledFile(
              path.join(monitorDir, file),
              path.join(incoming, "dist", "resource-monitor", file),
            );
          }
          // The bundle leaves native packages out and loads the installed T3 Code's own.
          const packages = installedPackagesDir(
            stockDir,
            path.join(paths.modsDir, "packages", currentVersion),
          );
          if (packages === null) return "node_modules";
          linkDirectory(packages, path.join(incoming, "node_modules"));
          return null;
        },
        catch: failed("Could not complete the build with this machine's own files."),
      });
      if (completed !== null) {
        return yield* new ModServiceError({
          stage: "activate",
          reason: `The build needs ${completed}, and this machine has no copy of it.`,
        });
      }

      // The other machine's path to its entry file; only the file's name holds here.
      const entryName = path.basename(manifest.value.entryPath ?? CUSTOM_BUILD_ENTRY);
      const entryPath = servesItsOwnServer ? path.join(buildDir, "dist", entryName) : undefined;
      const clientAssetsDir = path.join(buildDir, "dist", "client");
      const installed = {
        ...manifest.value,
        ...(entryPath !== undefined ? { entryPath } : {}),
        clientAssetsDir,
        sourceDir: "",
        workspaceDir: "",
        skippedModIds: [],
      };
      yield* encodeBuildManifest(installed).pipe(
        Effect.flatMap((text) =>
          fs.writeFileString(path.join(incoming, BUILD_MANIFEST_FILE), text),
        ),
        Effect.andThen(fs.remove(buildDir, { recursive: true, force: true })),
        Effect.andThen(fs.rename(incoming, buildDir)),
        Effect.mapError(failed("Could not store the build on this machine.")),
      );
      if (
        computeRuntimeOverrideArtifactSha256(entryPath, clientAssetsDir) !==
        manifest.value.artifactSha256
      ) {
        yield* fs.remove(buildDir, { recursive: true, force: true }).pipe(Effect.ignore);
        return yield* new ModServiceError({
          stage: "activate",
          activation: "artifact_mismatch",
          reason: "The build does not match what was approved on the other machine.",
        });
      }

      // This machine's mods become the build's: any other one would be gone from what runs.
      const included = new Set(manifest.value.mods.map((mod) => mod.id));
      for (const mod of manifest.value.mods) {
        const arrived = yield* readModDir(path.join(buildDir, "mods", mod.id));
        if (Option.isNone(arrived)) continue;
        yield* saveModFiles({
          dirPath: path.join(paths.patchesDir, mod.id),
          id: mod.id,
          title: arrived.value.metadata.title,
          intent: arrived.value.intent,
          verifySource: arrived.value.verifySource,
          verifyPath: arrived.value.metadata.verifyPath ?? VERIFY_SCRIPT_FILENAME,
          patchDiff: arrived.value.patchDiff,
          verifySha256: arrived.value.metadata.verifySha256,
          baseVersion: manifest.value.baseVersion,
          enabled: true,
        });
      }
      yield* Effect.forEach(
        (yield* listMods()).filter((mod) => mod.metadata.enabled && !included.has(mod.metadata.id)),
        (mod) => setModEnabled({ id: mod.metadata.id, enabled: false }),
        { discard: true },
      );

      yield* stopActivePreview();
      yield* pointTo({ ...manifest.value, entryPath, clientAssetsDir });
      const builds = yield* fs.readDirectory(paths.buildsDir).pipe(Effect.orElseSucceed(() => []));
      yield* Effect.forEach(
        builds.filter((entry) => entry !== buildId && BUILD_ID_PATTERN.test(entry)),
        removeBuild,
        { discard: true },
      ).pipe(Effect.ignore, Effect.forkIn(serviceScope));
      return { buildId, restartRequired: servesItsOwnServer || runsCustomServer };
    },
    Effect.scoped,
  );

  const exportMod: ModService["Service"]["exportMod"] = Effect.fn("ModService.exportMod")(
    function* ({ id, destinationDir }) {
      const sourceDir = path.join(paths.patchesDir, id);
      const existing = isValidModId(id)
        ? yield* readModDir(sourceDir)
        : Option.none<SavedModRecord>();
      if (Option.isNone(existing)) {
        return yield* new ModServiceError({
          stage: "storage",
          reason: `Mod "${id}" was not found.`,
        });
      }
      const exportedDir = path.resolve(destinationDir, id);
      yield* fs
        .makeDirectory(path.dirname(exportedDir), { recursive: true })
        .pipe(
          Effect.andThen(fs.copy(sourceDir, exportedDir, { overwrite: true })),
          Effect.mapError(failAs("storage", "Failed to export mod folder.")),
        );
      return { exportedDir };
    },
  );

  const importMod: ModService["Service"]["importMod"] = Effect.fn("ModService.importMod")(
    function* ({ sourceModDir }) {
      const resolved = path.resolve(sourceModDir);
      const mod = yield* readModDir(resolved);
      if (Option.isNone(mod)) {
        return yield* new ModServiceError({
          stage: "validation",
          reason: `Directory "${resolved}" does not contain a valid mod.json.`,
        });
      }
      const verifyPath = mod.value.metadata.verifyPath ?? VERIFY_SCRIPT_FILENAME;
      if (!isValidModId(mod.value.metadata.id) || !isSafeVerifyPath(verifyPath)) {
        return yield* new ModServiceError({
          stage: "validation",
          reason: `Imported mod "${mod.value.metadata.id}" has an invalid id or check path.`,
        });
      }
      if (mod.value.verifyTampered) {
        return yield* new ModServiceError({
          stage: "validation",
          reason: `Imported mod "${mod.value.metadata.id}" failed its verify.ts integrity hash check.`,
        });
      }
      const guardrails = checkPatchGuardrails(mod.value.patchDiff);
      if (guardrails.blocked.length > 0) {
        return yield* new ModServiceError({
          stage: "guardrail",
          reason: guardrails.blocked.join(" "),
        });
      }
      // An imported mod is someone else's code: it waits, disabled, until it is proposed here.
      const { dirPath, metadata } = yield* saveModFiles({
        dirPath: path.join(paths.patchesDir, mod.value.metadata.id),
        id: mod.value.metadata.id,
        title: mod.value.metadata.title,
        intent: mod.value.intent,
        verifySource: mod.value.verifySource,
        verifyPath,
        patchDiff: mod.value.patchDiff,
        verifySha256: mod.value.metadata.verifySha256,
        baseVersion: mod.value.metadata.baseVersion,
        enabled: false,
      });
      return { ...mod.value, metadata, dirPath };
    },
  );

  const checkUpgrade: ModService["Service"]["checkUpgrade"] = Effect.fn("ModService.checkUpgrade")(
    function* (input) {
      const mods = (yield* listMods()).filter((mod) => mod.metadata.enabled);
      if (mods.length === 0) return [];
      const source = yield* resolveSource(input?.sourceDir);
      const baseCommit = yield* resolveBaseCommit(source);
      const builder = input?.builder ?? defaultBuilder;
      const results: Array<ModUpgradeCheckEntry> = [];

      for (const mod of mods) {
        const entry = {
          id: mod.metadata.id,
          title: mod.metadata.title,
          previousBaseVersion: mod.metadata.baseVersion,
          intent: mod.intent,
        };
        if (mod.verifyTampered) {
          results.push({
            ...entry,
            status: "verify_tampered",
            detail:
              "Pinned verify.ts digest no longer matches mod.json. Re-approve verify.ts before upgrading.",
          });
          continue;
        }

        const verifyPath = mod.metadata.verifyPath ?? VERIFY_SCRIPT_FILENAME;
        const logPrefix = path.join(paths.logsDir, `upgrade-${mod.metadata.id}`);
        const outcome = yield* buildLock.withPermits(1)(
          Effect.scoped(
            Effect.gen(function* () {
              const checkout = yield* prepareBuildCheckout({
                name: BUILD_CHECKOUT_NAME,
                source,
                baseCommit,
                builder,
                logPrefix,
              });
              const stockRun = yield* runVerify({
                worktreeDir: checkout.worktreeDir,
                verifySource: mod.verifySource,
                verifyPath,
                env: checkout.env,
                logPath: `${logPrefix}-verify-stock.log`,
              });
              if (stockRun.passed) {
                return {
                  status: "already_fixed_upstream" as const,
                  detail:
                    "Pinned verify.ts passed on stock without applying patch.diff, so upstream likely includes this change now.",
                };
              }

              const applied = yield* applyPatch(checkout.worktreeDir, mod.patchDiff);
              if (!applied.ok) {
                return {
                  status: "needs_repair" as const,
                  detail: `Patch conflict on ${currentVersion}: ${applied.output}`,
                };
              }
              yield* checkout.installDependencies();

              const candidateRun = yield* runVerify({
                worktreeDir: checkout.worktreeDir,
                verifySource: mod.verifySource,
                verifyPath,
                env: checkout.env,
                logPath: `${logPrefix}-verify-candidate.log`,
              });
              return candidateRun.passed
                ? {
                    status: "ready" as const,
                    detail: `Patch applies cleanly and pinned verify.ts passed on ${currentVersion}.`,
                  }
                : {
                    status: "needs_repair" as const,
                    detail: `Patch applied cleanly, but pinned verify.ts failed on ${currentVersion}: ${candidateRun.output}`,
                  };
            }),
          ),
        );
        results.push({ ...entry, ...outcome });
      }

      return results;
    },
  );

  // A machine that only ever received builds has no source, and maybe no tools to build one.
  const buildsModsHere = Effect.fn("ModService.buildsModsHere")(function* (sourceDir?: string) {
    if (sourceDir?.trim() || hostEnv.T3CODE_MOD_SOURCE_DIR?.trim()) return true;
    if (Option.isSome(yield* findAncestor(import.meta.dirname, isT3CodeCheckout))) return true;
    return yield* exists(path.join(paths.sourceDir, ".git"));
  });

  const modKey = (mod: SavedModRecord) => `${mod.metadata.id}:${computeTextSha256(mod.patchDiff)}`;

  const rebuildPaused = Effect.fn("ModService.rebuildPaused")(function* (
    paused: ReadonlyArray<SavedModRecord>,
    input: Parameters<ModService["Service"]["rebuildAfterUpdate"]>[0],
  ) {
    const source = yield* resolveSource(input?.sourceDir);
    const baseCommit = yield* resolveBaseCommit(source);
    const builder = input?.builder ?? defaultBuilder;
    const buildId = `update-${(yield* random.uuidV4()).replaceAll("-", "").slice(0, 12)}`;
    const buildDir = path.join(paths.buildsDir, buildId);
    const logPrefix = path.join(paths.logsDir, buildId);

    const { fits, built } = yield* buildLock.withPermits(1)(
      Effect.scoped(
        Effect.gen(function* () {
          // Each mod goes on top of the ones before it, and stays only if its own check passes.
          const checked = yield* prepareBuildCheckout({
            name: CHECK_CHECKOUT_NAME,
            source,
            baseCommit,
            builder,
            logPrefix,
          });
          const fits: Array<SavedModRecord> = [];
          for (const mod of paused) {
            if (mod.verifyTampered) continue;
            if (!(yield* applyOrRestore(checked.worktreeDir, mod.patchDiff)).ok) continue;
            yield* checked.installDependencies();
            const check = yield* runVerify({
              worktreeDir: checked.worktreeDir,
              verifySource: mod.verifySource,
              verifyPath: mod.metadata.verifyPath ?? VERIFY_SCRIPT_FILENAME,
              env: checked.env,
              logPath: `${logPrefix}-verify-${mod.metadata.id}.log`,
            });
            if (check.passed) fits.push(mod);
            else yield* git(checked.worktreeDir, ["reset", "--hard", "HEAD~1"]);
          }
          if (fits.length === 0) return { fits, built: null };

          const checkout = yield* prepareBuildCheckout({
            name: BUILD_CHECKOUT_NAME,
            source,
            baseCommit,
            builder,
            logPrefix,
          });
          yield* Effect.forEach(
            fits,
            (mod) => applyOrRestore(checkout.worktreeDir, mod.patchDiff),
            {
              discard: true,
            },
          );
          yield* checkout.installDependencies();
          const built = yield* builder.bundle({
            worktreeDir: checkout.worktreeDir,
            buildDir,
            clientOnly: fits.every((mod) =>
              isClientOnlyChange(checkPatchGuardrails(mod.patchDiff).files),
            ),
            env: checkout.env,
            logPath: `${logPrefix}-build.log`,
          });
          return { fits, built };
        }),
      ).pipe(Effect.tapError(() => removeBuild(buildId).pipe(Effect.ignore))),
    );

    // The user applied or turned off a mod while this was building: what they did stands.
    const still = (yield* status()).paused.map(modKey);
    if (still.join("\n") !== paused.map(modKey).join("\n")) return yield* removeBuild(buildId);

    yield* Effect.forEach(
      paused.filter((mod) => !fits.includes(mod)),
      (mod) => resaveMod(mod, { enabled: false, needsRepair: true }),
      { discard: true },
    );
    if (built === null) return;
    const artifactSha256 = computeRuntimeOverrideArtifactSha256(
      built.entryPath,
      built.clientAssetsDir,
    );
    if (artifactSha256 === null) {
      return yield* new ModServiceError({
        stage: "build",
        reason: "The rebuilt mods are missing their server or their interface.",
      });
    }
    const mods = fits.map((mod) => ({
      id: mod.metadata.id,
      title: mod.metadata.title,
      verifySha256: mod.metadata.verifySha256,
      patchSha256: computeTextSha256(mod.patchDiff),
    }));
    yield* encodeBuildManifest({
      schemaVersion: 1,
      buildId,
      baseVersion: currentVersion,
      artifactSha256,
      ...built,
      sourceDir: source.dir,
      workspaceDir: "",
      skippedModIds: [],
      mods,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    }).pipe(
      Effect.flatMap((manifest) =>
        fs.writeFileString(path.join(buildDir, BUILD_MANIFEST_FILE), `${manifest}\n`),
      ),
      Effect.mapError(failAs("build", "Failed to write build manifest.")),
    );
    yield* Effect.forEach(
      fits,
      (mod) => resaveMod(mod, { enabled: true, baseVersion: currentVersion }),
      { discard: true },
    );
    yield* pointTo({ buildId, baseVersion: currentVersion, artifactSha256, ...built, mods });

    // Builds for the version before the update can never be applied again.
    const builds = yield* fs.readDirectory(paths.buildsDir).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(
      builds.filter((entry) => entry !== buildId && BUILD_ID_PATTERN.test(entry)),
      (entry) =>
        readManifest(entry).pipe(
          Effect.flatMap((manifest) =>
            manifest.baseVersion === currentVersion ? Effect.void : removeBuild(entry),
          ),
        ),
      { discard: true },
    ).pipe(Effect.ignore, Effect.forkIn(serviceScope));
  });

  const rebuildAfterUpdate: ModService["Service"]["rebuildAfterUpdate"] = Effect.fn(
    "ModService.rebuildAfterUpdate",
  )(function* (input) {
    const { paused } = yield* status();
    if (paused.length === 0 || config.devUrl !== undefined) return;
    if (!(yield* buildsModsHere(input?.sourceDir))) return;
    yield* Ref.set(rebuilding, true);
    yield* Ref.set(rebuildFailure, null);
    yield* rebuildPaused(paused, input).pipe(
      Effect.tapError((error) => Ref.set(rebuildFailure, error.message)),
      Effect.ensuring(Ref.set(rebuilding, false)),
    );
  });

  return ModService.of({
    status,
    listMods,
    startWorkspace,
    prepareCandidate,
    previewCandidate,
    activateBuild,
    discardCandidate,
    disableAll,
    setModEnabled,
    describeBuild,
    missingClientFiles,
    packBuild,
    installBuild,
    exportMod,
    importMod,
    checkUpgrade,
    rebuildAfterUpdate,
  });
});

export const layer = Layer.effect(ModService, make);

/** An update leaves the user's mods out of what runs, so a server that is up rebuilds them. */
export const rebuildAfterUpdateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const mods = yield* ModService;
    yield* forkParked(
      mods
        .rebuildAfterUpdate()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("mods were not rebuilt after the update", { cause }),
          ),
        ),
    );
  }),
);
