import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  computeRuntimeOverrideArtifactSha256,
  computeTextSha256,
  installedStateDir,
  readRuntimeOverrideFallback,
  readRuntimeOverridePointer,
  RUNTIME_OVERRIDE_ENV_ACTIVE,
  RUNTIME_OVERRIDE_ENV_ENTRY,
  RUNTIME_OVERRIDE_ENV_STATIC_DIR,
  writeRuntimeOverridePointer,
} from "@t3tools/shared/runtimeOverride";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

function makeTestLayers(baseDir: string, appVersion: string) {
  const envLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "arm64",
    appVersion,
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: baseDir,
          T3CODE_PORT: "9999",
          T3CODE_MODE: "desktop",
        }),
      ),
    ),
  );

  const foundation = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    envLayer,
    DesktopState.layer,
    DesktopManagedPolicy.layer.pipe(Layer.provide(Layer.merge(envLayer, NodeServices.layer))),
    Layer.succeed(DesktopShellEnvironment.DesktopShellEnvironment, {
      installIntoProcess: Effect.succeed(true),
      awaitDiscovery: Effect.succeed(true),
      awaitUserShellDiscovery: Effect.succeed(true),
      discoveryFinished: Effect.succeed(true),
      updates: Stream.empty,
    }),
    Layer.succeed(DesktopServerExposure.DesktopServerExposure, {
      getState: Effect.die("unexpected"),
      backendConfig: Effect.succeed({
        port: 4888,
        bindHost: "127.0.0.1",
        httpBaseUrl: new URL("http://127.0.0.1:4888"),
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      }),
      configureFromSettings: () => Effect.die("unexpected"),
      setMode: () => Effect.die("unexpected"),
      setTailscaleServeEnabled: () => Effect.die("unexpected"),
      getAdvertisedEndpoints: Effect.succeed([]),
    }),
    Layer.succeed(DesktopWslEnvironment.DesktopWslEnvironment, {
      isAvailable: Effect.succeed(false),
      probeDistros: Effect.succeed([]),
      getDistroIp: () => Effect.succeedNone,
      windowsToWslPath: () => Effect.succeedNone,
      ensureNodePty: () => Effect.die("unexpected"),
      preWarm: () => Effect.void,
      probeRuntime: () => Effect.die("unexpected"),
      prepareRuntime: () => Effect.die("unexpected"),
      resolveHomeDir: () => Effect.succeedNone,
    } as unknown as DesktopWslEnvironment.DesktopWslEnvironment["Service"]),
    Layer.succeed(DesktopWslServerTree.DesktopWslServerTree, {
      ensure: Effect.die("unexpected"),
      cleanupLegacy: Effect.void,
    } as unknown as DesktopWslServerTree.DesktopWslServerTree["Service"]),
  );

  const settingsLayer = DesktopAppSettings.layer.pipe(Layer.provide(foundation));
  return DesktopBackendConfiguration.layer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(foundation),
  );
}

const writeValidOverride = Effect.fn("test.writeValidOverride")(function* (
  baseDir: string,
  baseVersion: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = installedStateDir(baseDir);
  const buildRoot = path.join(stateDir, "mods", "builds", "candidate-1");
  const entryPath = path.join(buildRoot, "server", "bin.mjs");
  const clientAssetsDir = path.join(buildRoot, "client");
  yield* fs.makeDirectory(path.dirname(entryPath), { recursive: true });
  yield* fs.makeDirectory(clientAssetsDir, { recursive: true });
  yield* fs.writeFileString(entryPath, "console.log('custom');\n");
  yield* fs.writeFileString(path.join(clientAssetsDir, "index.html"), "<html>custom</html>");
  const artifactSha256 = computeRuntimeOverrideArtifactSha256(entryPath, clientAssetsDir)!;
  writeRuntimeOverridePointer(stateDir, {
    schemaVersion: 1,
    buildId: "candidate-1",
    baseVersion,
    artifactSha256,
    entryPath,
    clientAssetsDir,
    mods: [
      {
        id: "keep-settled",
        title: "Keep scheduled threads settled",
        verifySha256: computeTextSha256("verify"),
      },
    ],
    activatedAt: "2026-11-24T18:00:00.000Z",
    pendingTrial: true,
  });
  return { entryPath, clientAssetsDir };
});

describe("Desktop runtime override seam", () => {
  it.effect(
    "hands the custom build to the bundled server entry when override matches appVersion",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-override-" });
        const { entryPath, clientAssetsDir } = yield* writeValidOverride(baseDir, "0.1.11");

        const result = yield* Effect.gen(function* () {
          const env = yield* DesktopEnvironment.DesktopEnvironment;
          const config = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const state = yield* DesktopState.DesktopState;
          const resolved = yield* config.resolvePrimary;
          const active = yield* Ref.get(state.activeRuntimeOverride);
          return { env, resolved, active };
        }).pipe(Effect.provide(makeTestLayers(baseDir, "0.1.11")));

        // The bundled entry boots and is told which custom build to load.
        assert.equal(result.resolved.entryPath, result.env.backendEntryPath);
        assert.equal(result.resolved.env[RUNTIME_OVERRIDE_ENV_ENTRY], entryPath);
        assert.equal(result.resolved.env[RUNTIME_OVERRIDE_ENV_ACTIVE], "1");
        assert.equal(result.resolved.env[RUNTIME_OVERRIDE_ENV_STATIC_DIR], clientAssetsDir);
        assert.isTrue(Option.isSome(result.active));
        assert.equal(Option.getOrThrow(result.active).clientAssetsDir, clientAssetsDir);
        assert.isDefined(readRuntimeOverridePointer(installedStateDir(baseDir))?.trialStartedAt);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to stock backend when desktop updates to a newer appVersion", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-override-" });
      yield* writeValidOverride(baseDir, "0.1.11");

      const result = yield* Effect.gen(function* () {
        const env = yield* DesktopEnvironment.DesktopEnvironment;
        const config = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const state = yield* DesktopState.DesktopState;
        const resolved = yield* config.resolvePrimary;
        const active = yield* Ref.get(state.activeRuntimeOverride);
        return { env, resolved, active };
      }).pipe(Effect.provide(makeTestLayers(baseDir, "0.1.12")));

      assert.equal(result.resolved.entryPath, result.env.backendEntryPath);
      assert.isUndefined(result.resolved.env[RUNTIME_OVERRIDE_ENV_ACTIVE]);
      assert.isTrue(Option.isNone(result.active));
      assert.equal(
        readRuntimeOverrideFallback(installedStateDir(baseDir))?.reason,
        "version_mismatch",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
