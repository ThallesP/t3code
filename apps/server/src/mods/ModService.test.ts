import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { modsPaths, readRuntimeOverridePointer } from "@t3tools/shared/runtimeOverride";
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
  yield* runGit(repoDir, ["add", "feature.ts"]);
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
  bundle: ({ worktreeDir, buildDir }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const entryPath = path.join(buildDir, "dist", "bin.mjs");
      const clientAssetsDir = path.join(buildDir, "dist", "client");
      yield* fs.makeDirectory(clientAssetsDir, { recursive: true });
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
        // A workspace starts from stock, so its diff is this mod alone.
        assert.equal(
          yield* fs.readFileString(path.join(second.workspaceDir, "feature.ts")),
          "export const keepScheduledSettled = false;\n",
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
          "export const keepScheduledSettled = \"never\";\n",
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
});
