// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the synchronous Node runtimeOverride API directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  checkPatchGuardrails,
  claimedRuntimeOverride,
  claimRuntimeOverride,
  computeRuntimeOverrideArtifactSha256,
  computeTextSha256,
  failRuntimeOverrideStartup,
  isServerStartInvocation,
  isStockModeRequested,
  isValidModId,
  markRuntimeOverrideHealthy,
  markRuntimeOverrideTrialStarted,
  readLiveClientAssetsDir,
  readRuntimeOverrideFallback,
  readRuntimeOverridePointer,
  releaseRuntimeOverride,
  resolveActiveRuntimeOverride,
  runtimeOverrideEnv,
  writeRuntimeOverridePointer,
  type RuntimeOverridePointer,
} from "./runtimeOverride.ts";

const tempDirs: Array<string> = [];

function makeTempBaseDir(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-runtime-override-"));
  tempDirs.push(dir);
  return dir;
}

function writeFakeBuild(stateDir: string, buildId = "build-1") {
  const buildRoot = NodePath.join(stateDir, "mods", "builds", buildId);
  const entryPath = NodePath.join(buildRoot, "server", "bin.mjs");
  const clientAssetsDir = NodePath.join(buildRoot, "client");
  NodeFS.mkdirSync(NodePath.dirname(entryPath), { recursive: true });
  NodeFS.mkdirSync(clientAssetsDir, { recursive: true });
  NodeFS.writeFileSync(entryPath, "export const server = 'custom';\n");
  NodeFS.writeFileSync(NodePath.join(clientAssetsDir, "index.html"), "<html>custom</html>\n");
  const artifactSha256 = computeRuntimeOverrideArtifactSha256(entryPath, clientAssetsDir)!;
  return { buildId, entryPath, clientAssetsDir, artifactSha256 };
}

function makePointer(
  build: ReturnType<typeof writeFakeBuild>,
  overrides: Partial<RuntimeOverridePointer> = {},
): RuntimeOverridePointer {
  return {
    schemaVersion: 1,
    buildId: build.buildId,
    baseVersion: "0.1.11",
    artifactSha256: build.artifactSha256,
    entryPath: build.entryPath,
    clientAssetsDir: build.clientAssetsDir,
    mods: [
      {
        id: "keep-scheduled-settled",
        title: "Keep scheduled threads settled",
        verifySha256: computeTextSha256("verify"),
      },
    ],
    activatedAt: "2026-11-24T18:00:00.000Z",
    pendingTrial: true,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtimeOverride", () => {
  it("resolves a verified override matching currentVersion and transitions trial -> healthy", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    writeRuntimeOverridePointer(stateDir, makePointer(build));

    const resolved = resolveActiveRuntimeOverride({ stateDir, currentVersion: "0.1.11" });
    expect(resolved.status).toBe("override");
    if (resolved.status !== "override") return;
    expect(resolved.override.entryPath).toBe(build.entryPath);

    markRuntimeOverrideTrialStarted(stateDir, "2026-11-24T18:01:00.000Z");
    expect(readRuntimeOverridePointer(stateDir)?.trialStartedAt).toBe("2026-11-24T18:01:00.000Z");

    markRuntimeOverrideHealthy(stateDir, "2026-11-24T18:01:05.000Z");
    const healthy = readRuntimeOverridePointer(stateDir);
    expect(healthy?.pendingTrial).toBe(false);
    expect(healthy?.trialPassedAt).toBe("2026-11-24T18:01:05.000Z");
  });

  it("starts a build's trial only on a server start, never on a launcher's probe", () => {
    for (const argv of [
      [],
      ["serve", "--host", "127.0.0.1", "--port", "3773", "--base-dir", "/home/me/.t3"],
      ["--port", "3773"],
      ["start"],
    ]) {
      expect(isServerStartInvocation(argv), argv.join(" ")).toBe(true);
    }
    for (const argv of [
      ["--version"],
      ["--help"],
      ["serve", "--help"],
      ["__ssh-helper", "pick-port"],
      ["mod", "status"],
      ["--base-dir", "/home/me/.t3", "auth", "pairing", "create"],
    ]) {
      expect(isServerStartInvocation(argv), argv.join(" ")).toBe(false);
    }
  });

  it("serves a client-only build at once and leaves a server build to its restart", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    const live = () => readLiveClientAssetsDir({ stateDir, currentVersion: "0.1.11" });

    writeRuntimeOverridePointer(stateDir, makePointer(build));
    expect(live()).toBeNull();

    const { entryPath: _entry, pendingTrial: _trial, ...withServer } = makePointer(build);
    const clientOnly = {
      ...withServer,
      artifactSha256: computeRuntimeOverrideArtifactSha256(undefined, build.clientAssetsDir)!,
    };
    writeRuntimeOverridePointer(stateDir, clientOnly);
    expect(live()).toBe(build.clientAssetsDir);
    expect(runtimeOverrideEnv(clientOnly)).toEqual({});
    // A client-only build has no start to fail, so a restart never falls back from it.
    expect(resolveActiveRuntimeOverride({ stateDir, currentVersion: "0.1.11" }).status).toBe(
      "override",
    );
    expect(
      readLiveClientAssetsDir({ stateDir, currentVersion: "0.1.11", argv: ["--stock"] }),
    ).toBeNull();
    expect(readLiveClientAssetsDir({ stateDir, currentVersion: "0.1.12" })).toBeNull();
  });

  it("takes a launcher's build once and leaves nothing for the server's children to inherit", () => {
    const env: NodeJS.ProcessEnv = {
      ...runtimeOverrideEnv({
        entryPath: "/builds/a/bin.mjs",
        clientAssetsDir: "/builds/a/client",
      }),
      PATH: "/usr/bin",
    };

    expect(claimRuntimeOverride(env, "/opt/t3")).toEqual({
      entryPath: "/builds/a/bin.mjs",
      clientAssetsDir: "/builds/a/client",
      stockDir: "/opt/t3",
    });
    // An agent's shell gets this environment: a `t3` started there must run its own code.
    expect(env).toEqual({ PATH: "/usr/bin" });
    expect(claimedRuntimeOverride()?.entryPath).toBe("/builds/a/bin.mjs");
    expect(claimRuntimeOverride(env, "/opt/t3")?.entryPath).toBe("/builds/a/bin.mjs");

    releaseRuntimeOverride();
    expect(claimedRuntimeOverride()).toBeNull();
    expect(claimRuntimeOverride({ PATH: "/usr/bin" }, "/opt/t3")).toBeNull();
  });

  it("falls back to stock when a previous trial crashed before becoming healthy", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    writeRuntimeOverridePointer(stateDir, makePointer(build));
    markRuntimeOverrideTrialStarted(stateDir, "2026-11-24T18:01:00.000Z");

    const resolved = resolveActiveRuntimeOverride({ stateDir, currentVersion: "0.1.11" });
    expect(resolved.status).toBe("stock");
    if (resolved.status !== "stock") return;
    expect(resolved.reason).toBe("trial_crashed");
    expect(readRuntimeOverridePointer(stateDir)).toBeNull();
    expect(readRuntimeOverrideFallback(stateDir)?.reason).toBe("trial_crashed");
  });

  it("falls back to stock and records version_mismatch when upstream updates", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    writeRuntimeOverridePointer(stateDir, makePointer(build, { pendingTrial: false }));

    const resolved = resolveActiveRuntimeOverride({ stateDir, currentVersion: "0.1.12" });
    expect(resolved.status).toBe("stock");
    if (resolved.status !== "stock") return;
    expect(resolved.reason).toBe("version_mismatch");
    const fallback = readRuntimeOverrideFallback(stateDir);
    expect(fallback?.overrideBaseVersion).toBe("0.1.11");
    expect(fallback?.currentVersion).toBe("0.1.12");
  });

  it("falls back to stock when artifact integrity fails after tampering", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    writeRuntimeOverridePointer(stateDir, makePointer(build, { pendingTrial: false }));
    NodeFS.writeFileSync(build.entryPath, "export const server = 'tampered';\n");

    const resolved = resolveActiveRuntimeOverride({ stateDir, currentVersion: "0.1.11" });
    expect(resolved.status).toBe("stock");
    if (resolved.status !== "stock") return;
    expect(resolved.reason).toBe("integrity_mismatch");
    expect(readRuntimeOverridePointer(stateDir)).toBeNull();
  });

  it("honors --stock and T3CODE_STOCK without disabling active.json", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    writeRuntimeOverridePointer(stateDir, makePointer(build, { pendingTrial: false }));

    expect(isStockModeRequested({ T3CODE_STOCK: "1" }, [])).toBe(true);
    expect(isStockModeRequested({}, ["--stock"])).toBe(true);

    const resolved = resolveActiveRuntimeOverride({
      stateDir,
      currentVersion: "0.1.11",
      argv: ["--stock"],
    });
    expect(resolved.status).toBe("stock");
    if (resolved.status !== "stock") return;
    expect(resolved.reason).toBe("stock_mode");
    expect(readRuntimeOverridePointer(stateDir)).not.toBeNull();
  });

  it("records startup failure and clears active override", () => {
    const stateDir = makeTempBaseDir();
    const build = writeFakeBuild(stateDir);
    writeRuntimeOverridePointer(stateDir, makePointer(build));

    const record = failRuntimeOverrideStartup({
      stateDir,
      currentVersion: "0.1.11",
      message: "Backend crashed during startup.",
    });
    expect(record.reason).toBe("startup_failed");
    expect(record.buildId).toBe(build.buildId);
    expect(readRuntimeOverridePointer(stateDir)).toBeNull();
    expect(readRuntimeOverrideFallback(stateDir)?.message).toBe("Backend crashed during startup.");
  });

  it("enforces static patch guardrails and slug rules", () => {
    expect(isValidModId("keep-scheduled-settled")).toBe(true);
    expect(isValidModId("Bad_Slug")).toBe(false);
    expect(isValidModId("../escape")).toBe(false);

    const migrationPatch = [
      "diff --git a/apps/server/src/persistence/Migrations/042_custom.ts b/apps/server/src/persistence/Migrations/042_custom.ts",
      "+++ b/apps/server/src/persistence/Migrations/042_custom.ts",
      "diff --git a/apps/desktop/src/main.ts b/apps/desktop/src/main.ts",
      "+++ b/apps/desktop/src/main.ts",
      "diff --git a/apps/web/src/components/App.tsx b/apps/web/src/components/App.tsx",
      "+++ b/apps/web/src/components/App.tsx",
    ].join("\n");

    const check = checkPatchGuardrails(migrationPatch);
    expect(check.files).toEqual([
      "apps/desktop/src/main.ts",
      "apps/server/src/persistence/Migrations/042_custom.ts",
      "apps/web/src/components/App.tsx",
    ]);
    expect(check.blocked).toHaveLength(1);
    expect(check.warnings).toHaveLength(1);
  });
});
