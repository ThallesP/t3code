import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import {
  modsPaths,
  readLiveClientAssetsDir,
  readRuntimeOverridePointer,
  resolveActiveRuntimeOverride,
  writeRuntimeOverridePointer,
} from "@t3tools/shared/runtimeOverride";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ModService from "./ModService.ts";

const runGit = Effect.fn("test.runGit")(function* (cwd: string, args: ReadonlyArray<string>) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({ command: "git", args, cwd });
  assert.equal(result.code, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
});

const MOD_ID = "keep-scheduled-settled";

const initTestRepo = Effect.fn("test.initTestRepo")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mod-repo-" });
  // Mod checkouts are made beside the source checkout.
  yield* Effect.addFinalizer(() =>
    fs.remove(`${repoDir}-mods`, { recursive: true, force: true }).pipe(Effect.ignore),
  );
  yield* runGit(repoDir, ["init"]);
  yield* runGit(repoDir, ["config", "user.email", "test@t3.codes"]);
  yield* runGit(repoDir, ["config", "user.name", "T3 Test"]);
  yield* fs.writeFileString(
    path.join(repoDir, "feature.ts"),
    "export const keepScheduledSettled = false;\n",
  );
  yield* fs.makeDirectory(path.join(repoDir, "apps", "web"), { recursive: true });
  yield* fs.writeFileString(
    path.join(repoDir, "apps", "web", "banner.ts"),
    'export const banner = "stock";\n',
  );
  yield* runGit(repoDir, ["add", "feature.ts", "apps"]);
  yield* runGit(repoDir, ["commit", "-m", "stock"]);
  return repoDir;
});

const VERIFY_KEEP_SETTLED = [
  'import assert from "node:assert/strict";',
  'import { keepScheduledSettled } from "./feature.ts";',
  'assert.equal(keepScheduledSettled, true, "expected keepScheduledSettled to be true");',
  "",
].join("\n");

// Bundles by concatenating the checkout's sources, so a test can read what was built.
const fakeBuilder: ModService.ModBuilder = {
  install: () => Effect.void,
  bundle: ({ worktreeDir, buildDir, clientOnly }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entryPath = path.join(buildDir, "dist", "bin.mjs");
      const clientAssetsDir = path.join(buildDir, "dist", "client");
      yield* fs.makeDirectory(clientAssetsDir, { recursive: true });
      if (clientOnly) {
        yield* fs.writeFileString(
          path.join(clientAssetsDir, "index.html"),
          yield* fs.readFileString(path.join(worktreeDir, "apps", "web", "banner.ts")),
        );
        return { clientAssetsDir };
      }
      const sources = (yield* fs.readDirectory(worktreeDir))
        .filter((entry) => entry.endsWith(".ts"))
        .toSorted();
      const contents = yield* Effect.forEach(sources, (entry) =>
        fs.readFileString(path.join(worktreeDir, entry)),
      );
      yield* fs.writeFileString(entryPath, contents.join(""));
      yield* fs.writeFileString(path.join(clientAssetsDir, "index.html"), "<html>custom</html>\n");
      return { entryPath, clientAssetsDir };
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.mapError(
        (cause) => new ModService.ModServiceError({ stage: "build", reason: "fake", cause }),
      ),
    ),
};

const proposeKeepSettled = Effect.fn("test.proposeKeepSettled")(function* (repoDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const modService = yield* ModService.ModService;
  const workspace = yield* modService.startWorkspace({
    id: MOD_ID,
    sourceDir: repoDir,
    builder: fakeBuilder,
  });
  yield* fs.writeFileString(
    path.join(workspace.workspaceDir, "feature.ts"),
    "export const keepScheduledSettled = true;\n",
  );
  const preview = yield* modService.prepareCandidate({
    id: MOD_ID,
    title: "Keep scheduled threads settled",
    intent: "Keep scheduled task threads settled after their run finishes.",
    verifySource: VERIFY_KEEP_SETTLED,
    sourceDir: repoDir,
    builder: fakeBuilder,
  });
  return { workspace, preview };
});

const makeLayer = (cwd: string) =>
  ModService.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(cwd, { prefix: "t3-mod-service-" })),
    Layer.provideMerge(ProcessRunner.layer),
    Layer.provideMerge(NetService.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(NodeCrypto.layer),
  );

describe("ModService", () => {
  it.live("builds the workspace's change, saves the mod only on apply, and rolls back", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;
        const config = yield* ServerConfig.ServerConfig;

        const { workspace, preview } = yield* proposeKeepSettled(repoDir);

        assert.isTrue(workspace.created);
        assert.equal(workspace.savedPatch, "none");
        assert.isTrue(preview.verification.stockFailed);
        assert.isTrue(preview.verification.candidatePassed);
        assert.deepEqual(preview.files, ["feature.ts"]);
        assert.isEmpty(preview.warnings);
        // A proposal the user has not approved is not one of their mods.
        assert.isEmpty(yield* modService.listMods());

        const wrongDigest = yield* modService
          .activateBuild({
            buildId: preview.buildId,
            expectedArtifactSha256: "0".repeat(64),
          })
          .pipe(Effect.flip);
        assert.equal(wrongDigest.activation, "artifact_mismatch");
        assert.isNull(readRuntimeOverridePointer(config.stateDir));

        const activated = yield* modService.activateBuild({
          buildId: preview.buildId,
          expectedArtifactSha256: preview.artifactSha256,
        });
        assert.isTrue(activated.restartRequired);

        const pointer = readRuntimeOverridePointer(config.stateDir);
        assert.equal(pointer?.buildId, preview.buildId);
        assert.equal(pointer?.artifactSha256, preview.artifactSha256);
        assert.isTrue(pointer?.pendingTrial);
        assert.deepEqual(
          (yield* modService.listMods()).map((mod) => mod.metadata.id),
          [MOD_ID],
        );

        yield* modService.disableAll();
        assert.isNull(readRuntimeOverridePointer(config.stateDir));
        // Off stays off: the mod must not ride back in with the next mod's build.
        assert.deepEqual(
          (yield* modService.listMods()).map((mod) => mod.metadata.enabled),
          [false],
        );
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live(
    "applies a change to the web client alone with no restart, and turns it off the same way",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repoDir = yield* initTestRepo();
          const modService = yield* ModService.ModService;
          const config = yield* ServerConfig.ServerConfig;

          const workspace = yield* modService.startWorkspace({
            id: "new-banner",
            sourceDir: repoDir,
            builder: fakeBuilder,
          });
          yield* fs.writeFileString(
            path.join(workspace.workspaceDir, "apps", "web", "banner.ts"),
            'export const banner = "custom";\n',
          );
          const preview = yield* modService.prepareCandidate({
            id: "new-banner",
            title: "A new banner",
            intent: "The banner reads custom.",
            verifySource:
              'import { banner } from "./apps/web/banner.ts";\nif (banner !== "custom") process.exit(1);\n',
            sourceDir: repoDir,
            builder: fakeBuilder,
          });
          assert.isTrue(preview.verification.stockFailed);
          assert.isFalse(preview.restartRequired);

          const activated = yield* modService.activateBuild({
            buildId: preview.buildId,
            expectedArtifactSha256: preview.artifactSha256,
          });
          assert.isFalse(activated.restartRequired);
          const pointer = readRuntimeOverridePointer(config.stateDir);
          assert.isUndefined(pointer?.entryPath);
          // No server of its own, so no start that could fail.
          assert.isUndefined(pointer?.pendingTrial);

          const served = () =>
            readLiveClientAssetsDir({
              stateDir: config.stateDir,
              currentVersion: preview.baseVersion,
            });
          const liveDir = served();
          assert.equal(liveDir, pointer?.clientAssetsDir);
          assert.include(
            yield* fs.readFileString(path.join(liveDir ?? "", "index.html")),
            '"custom"',
          );

          assert.isFalse((yield* modService.disableAll()).restartRequired);
          assert.isNull(served());
        }).pipe(Effect.provide(makeLayer("/tmp"))),
      ),
  );

  it.live("builds a mod that changes the same lines as an earlier one on top of it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;

        const first = yield* proposeKeepSettled(repoDir);
        yield* modService.activateBuild({
          buildId: first.preview.buildId,
          expectedArtifactSha256: first.preview.artifactSha256,
        });

        const second = yield* modService.startWorkspace({
          id: "always-settled",
          sourceDir: repoDir,
          builder: fakeBuilder,
        });
        assert.deepEqual(
          second.builtOn.map((mod) => mod.id),
          [first.preview.modId],
        );
        yield* fs.writeFileString(
          path.join(second.workspaceDir, "feature.ts"),
          'export const keepScheduledSettled = "always";\n',
        );
        const preview = yield* modService.prepareCandidate({
          id: "always-settled",
          title: "Always keep scheduled threads settled",
          intent: "Scheduled threads stay settled, whatever their run did.",
          verifySource:
            'import { keepScheduledSettled } from "./feature.ts";\nif (keepScheduledSettled !== "always") process.exit(1);\n',
          sourceDir: repoDir,
          builder: fakeBuilder,
        });

        assert.isTrue(preview.verification.stockFailed);
        assert.include(preview.diffPreview, "-export const keepScheduledSettled = true;");
        assert.equal(
          yield* fs.readFileString(
            path.join(
              modsPaths((yield* ServerConfig.ServerConfig).stateDir).buildsDir,
              preview.buildId,
              "dist",
              "bin.mjs",
            ),
          ),
          'export const keepScheduledSettled = "always";\n',
        );
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live("keeps applied mods in the next mod's build and refuses a build they outdated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;

        const first = yield* proposeKeepSettled(repoDir);
        yield* modService.activateBuild({
          buildId: first.preview.buildId,
          expectedArtifactSha256: first.preview.artifactSha256,
        });

        const second = yield* modService.startWorkspace({
          id: "wake-on-pr",
          sourceDir: repoDir,
          builder: fakeBuilder,
        });
        // A workspace is T3 Code as the user has it, so a change beside an earlier mod is
        // written against it. The diff is still this mod alone.
        assert.equal(
          yield* fs.readFileString(path.join(second.workspaceDir, "feature.ts")),
          "export const keepScheduledSettled = true;\n",
        );
        yield* fs.writeFileString(
          path.join(second.workspaceDir, "wake.ts"),
          "export const wakeOnPullRequest = true;\n",
        );
        const preview = yield* modService.prepareCandidate({
          id: "wake-on-pr",
          title: "Wake a thread when its pull request is ready",
          intent: "Wake the thread once its pull request is approved and green.",
          verifySource:
            'import { wakeOnPullRequest } from "./wake.ts";\nif (!wakeOnPullRequest) process.exit(1);\n',
          sourceDir: repoDir,
          builder: fakeBuilder,
        });

        assert.deepEqual(preview.files, ["wake.ts"]);
        const built = yield* fs.readFileString(
          path.join(
            modsPaths((yield* ServerConfig.ServerConfig).stateDir).buildsDir,
            preview.buildId,
            "dist",
            "bin.mjs",
          ),
        );
        assert.include(built, "keepScheduledSettled = true");
        assert.include(built, "wakeOnPullRequest = true");

        yield* modService.setModEnabled({ id: MOD_ID, enabled: false });
        const stale = yield* modService
          .activateBuild({
            buildId: preview.buildId,
            expectedArtifactSha256: preview.artifactSha256,
          })
          .pipe(Effect.flip);
        assert.equal(stale.activation, "stale_build");
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live("leaves out a mod an update broke, says so, and turns it off on apply", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;

        const first = yield* proposeKeepSettled(repoDir);
        yield* modService.activateBuild({
          buildId: first.preview.buildId,
          expectedArtifactSha256: first.preview.artifactSha256,
        });

        // The update rewrites the line the saved mod changes.
        yield* fs.writeFileString(
          path.join(repoDir, "feature.ts"),
          'export const keepScheduledSettled = "never";\n',
        );
        yield* runGit(repoDir, ["commit", "-am", "upstream rewrite"]);

        const workspace = yield* modService.startWorkspace({
          id: "wake-on-pr",
          sourceDir: repoDir,
          builder: fakeBuilder,
        });
        yield* fs.writeFileString(
          path.join(workspace.workspaceDir, "wake.ts"),
          "export const wakeOnPullRequest = true;\n",
        );
        const preview = yield* modService.prepareCandidate({
          id: "wake-on-pr",
          title: "Wake a thread when its pull request is ready",
          intent: "Wake the thread once its pull request is approved and green.",
          verifySource:
            'import { wakeOnPullRequest } from "./wake.ts";\nif (!wakeOnPullRequest) process.exit(1);\n',
          sourceDir: repoDir,
          builder: fakeBuilder,
        });

        assert.lengthOf(preview.warnings, 1);
        assert.include(preview.warnings[0], "Keep scheduled threads settled");
        const built = yield* fs.readFileString(
          path.join(
            modsPaths((yield* ServerConfig.ServerConfig).stateDir).buildsDir,
            preview.buildId,
            "dist",
            "bin.mjs",
          ),
        );
        // No conflict markers from the broken mod leak into the build.
        assert.equal(
          built,
          'export const keepScheduledSettled = "never";\nexport const wakeOnPullRequest = true;\n',
        );

        yield* modService.activateBuild({
          buildId: preview.buildId,
          expectedArtifactSha256: preview.artifactSha256,
        });
        assert.deepEqual(
          (yield* modService.listMods()).map((mod) => [mod.metadata.id, mod.metadata.enabled]),
          [
            [MOD_ID, false],
            ["wake-on-pr", true],
          ],
        );
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live("starts from the source checkout as it is on disk without touching its index", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;
        yield* fs.writeFileString(path.join(repoDir, "unreleased.ts"), "export const wip = 1;\n");
        const statusBefore = yield* runGit(repoDir, ["status", "--porcelain"]);

        const workspace = yield* modService.startWorkspace({
          id: MOD_ID,
          sourceDir: repoDir,
          builder: fakeBuilder,
        });

        assert.equal(
          yield* fs.readFileString(path.join(workspace.workspaceDir, "unreleased.ts")),
          "export const wip = 1;\n",
        );
        assert.equal(yield* runGit(repoDir, ["status", "--porcelain"]), statusBefore);
        // Uncommitted source work is the base, not part of the mod.
        const empty = yield* modService
          .prepareCandidate({
            id: MOD_ID,
            title: "Nothing",
            intent: "Nothing.",
            verifySource: "process.exit(0);\n",
            sourceDir: repoDir,
            builder: fakeBuilder,
          })
          .pipe(Effect.flip);
        assert.equal(empty.stage, "validation");
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live("blocks changes to core SQLite migrations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;
        const workspace = yield* modService.startWorkspace({
          id: "bad-mod",
          sourceDir: repoDir,
          builder: fakeBuilder,
        });
        const migrationsDir = path.join(
          workspace.workspaceDir,
          "apps/server/src/persistence/Migrations",
        );
        yield* fs.makeDirectory(migrationsDir, { recursive: true });
        yield* fs.writeFileString(path.join(migrationsDir, "999_mod.ts"), "export {};\n");

        const error = yield* modService
          .prepareCandidate({
            id: "bad-mod",
            title: "Bad mod",
            intent: "Touch migrations",
            verifySource: "console.log('ok');",
            sourceDir: repoDir,
            builder: fakeBuilder,
          })
          .pipe(Effect.flip);

        assert.equal(error.stage, "guardrail");
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live(
    "after an update, rebuilds the mods that still fit and turns off the one that does not",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const repoDir = yield* initTestRepo();
          const modService = yield* ModService.ModService;
          const { stateDir } = yield* ServerConfig.ServerConfig;

          const first = yield* proposeKeepSettled(repoDir);
          yield* modService.activateBuild({
            buildId: first.preview.buildId,
            expectedArtifactSha256: first.preview.artifactSha256,
          });
          const workspace = yield* modService.startWorkspace({
            id: "wake-on-pr",
            sourceDir: repoDir,
            builder: fakeBuilder,
          });
          yield* fs.writeFileString(
            path.join(workspace.workspaceDir, "wake.ts"),
            "export const wakeOnPullRequest = true;\n",
          );
          const second = yield* modService.prepareCandidate({
            id: "wake-on-pr",
            title: "Wake a thread when its pull request is ready",
            intent: "Wake the thread once its pull request is approved and green.",
            verifySource:
              'import { wakeOnPullRequest } from "./wake.ts";\nif (!wakeOnPullRequest) process.exit(1);\n',
            sourceDir: repoDir,
            builder: fakeBuilder,
          });
          yield* modService.activateBuild({
            buildId: second.buildId,
            expectedArtifactSha256: second.artifactSha256,
          });

          // The update rewrites the line the first mod changes, and the new version starts.
          yield* fs.writeFileString(
            path.join(repoDir, "feature.ts"),
            'export const keepScheduledSettled = "never";\n',
          );
          yield* runGit(repoDir, ["commit", "-am", "upstream rewrite"]);
          const applied = readRuntimeOverridePointer(stateDir)!;
          writeRuntimeOverridePointer(stateDir, { ...applied, baseVersion: "0.0.1" });
          resolveActiveRuntimeOverride({ stateDir, currentVersion: applied.baseVersion });

          const paused = yield* modService.status();
          assert.isNull(paused.activeOverride);
          assert.deepEqual(
            paused.paused.map((mod) => mod.metadata.id),
            [MOD_ID, "wake-on-pr"],
          );

          yield* modService.rebuildAfterUpdate({ sourceDir: repoDir, builder: fakeBuilder });

          const rebuilt = yield* modService.status();
          assert.deepEqual(
            rebuilt.activeOverride?.mods.map((mod) => mod.id),
            ["wake-on-pr"],
          );
          assert.isNull(rebuilt.fallback);
          assert.lengthOf(rebuilt.paused, 0);
          assert.deepEqual(
            rebuilt.mods.map((mod) => [
              mod.metadata.id,
              mod.metadata.enabled,
              mod.metadata.needsRepair === true,
            ]),
            [
              [MOD_ID, false, true],
              ["wake-on-pr", true, false],
            ],
          );
          assert.equal(
            yield* fs.readFileString(rebuilt.activeOverride!.entryPath!),
            'export const keepScheduledSettled = "never";\nexport const wakeOnPullRequest = true;\n',
          );
        }).pipe(Effect.provide(makeLayer("/tmp"))),
      ),
  );

  it.live("detects ready, already_fixed_upstream, and verify_tampered during upgrade check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repoDir = yield* initTestRepo();
        const modService = yield* ModService.ModService;
        const upgrade = { sourceDir: repoDir, builder: fakeBuilder };

        const { preview } = yield* proposeKeepSettled(repoDir);
        yield* modService.activateBuild({
          buildId: preview.buildId,
          expectedArtifactSha256: preview.artifactSha256,
        });

        // 1. Clean upgrade against unchanged stock -> ready.
        const readyCheck = yield* modService.checkUpgrade(upgrade);
        assert.equal(readyCheck.length, 1);
        assert.equal(readyCheck[0]?.status, "ready");

        // 2. Upstream adopts the fix -> pinned verify.ts passes on stock -> already_fixed_upstream.
        yield* fs.writeFileString(
          path.join(repoDir, "feature.ts"),
          "export const keepScheduledSettled = true;\n",
        );
        yield* runGit(repoDir, ["add", "feature.ts"]);
        yield* runGit(repoDir, ["commit", "-m", "upstream fix"]);

        const fixedCheck = yield* modService.checkUpgrade(upgrade);
        assert.equal(fixedCheck[0]?.status, "already_fixed_upstream");

        const exportParent = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mod-export-" });
        const { exportedDir } = yield* modService.exportMod({
          id: MOD_ID,
          destinationDir: exportParent,
        });

        // 3. Tampering with pinned verify.ts is flagged on upgrade check.
        const mods = yield* modService.listMods();
        yield* fs.writeFileString(
          path.join(mods[0]!.dirPath, "verify.ts"),
          "console.log('weak');\n",
        );
        const tamperedCheck = yield* modService.checkUpgrade(upgrade);
        assert.equal(tamperedCheck[0]?.status, "verify_tampered");

        // 4. A shared mod imports intact but stays off until it is proposed and approved here.
        const imported = yield* modService.importMod({ sourceModDir: exportedDir });
        assert.equal(imported.metadata.id, MOD_ID);
        assert.isFalse(imported.verifyTampered);
        assert.isFalse(imported.metadata.enabled);
      }).pipe(Effect.provide(makeLayer("/tmp"))),
    ),
  );

  it.live("runs a build made on one machine on another, with its mods and nothing rebuilt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const packPath = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "t3-mod-pack-" }),
          "build.pack",
        );
        // Two machines: each layer has its own T3 home.
        const origin = yield* Layer.build(makeLayer("/tmp"));
        const other = yield* Layer.build(makeLayer("/tmp"));

        const built = yield* Effect.gen(function* () {
          const modService = yield* ModService.ModService;
          const { preview } = yield* proposeKeepSettled(yield* initTestRepo());
          yield* modService.activateBuild({
            buildId: preview.buildId,
            expectedArtifactSha256: preview.artifactSha256,
          });
          return yield* modService.describeBuild({ buildId: preview.buildId });
        }).pipe(Effect.provide(origin));
        assert.isTrue(built.restartRequired);
        assert.deepEqual(built.clientFiles, ["index.html"]);

        // The other machine says which interface files it lacks, and is sent only those.
        const missing = yield* Effect.gen(function* () {
          const modService = yield* ModService.ModService;
          return yield* modService.missingClientFiles(built.clientFiles);
        }).pipe(Effect.provide(other));
        assert.deepEqual(missing, ["index.html"]);
        yield* Effect.gen(function* () {
          const modService = yield* ModService.ModService;
          yield* modService.packBuild({ buildId: built.buildId, clientFiles: missing, packPath });
        }).pipe(Effect.provide(origin));

        yield* Effect.gen(function* () {
          const modService = yield* ModService.ModService;
          const config = yield* ServerConfig.ServerConfig;
          const installed = yield* modService.installBuild({ packPath });
          assert.deepEqual(installed, { buildId: built.buildId, restartRequired: true });

          const pointer = readRuntimeOverridePointer(config.stateDir);
          assert.equal(pointer?.buildId, built.buildId);
          assert.equal(pointer?.artifactSha256, built.artifactSha256);
          assert.isTrue(pointer?.pendingTrial);
          // The files are this machine's own copy, not a path on the first one.
          assert.isTrue(pointer?.entryPath?.startsWith(config.stateDir));
          assert.include(
            yield* fs.readFileString(pointer?.entryPath ?? ""),
            "export const keepScheduledSettled = true;",
          );
          // The mod came along, so this machine lists it and can rebuild it after an update.
          const mods = yield* modService.listMods();
          assert.deepEqual(
            mods.map((mod) => [mod.metadata.id, mod.metadata.enabled]),
            [[MOD_ID, true]],
          );

          yield* fs.writeFileString(packPath, "not a pack");
          const damaged = yield* modService.installBuild({ packPath }).pipe(Effect.flip);
          assert.equal(damaged.stage, "activate");
          assert.equal(readRuntimeOverridePointer(config.stateDir)?.buildId, built.buildId);
        }).pipe(Effect.provide(other));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});
