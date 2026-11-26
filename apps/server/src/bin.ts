// @effect-diagnostics nodeBuiltinImport:off -- The service launcher starts before the CLI runtime.
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSea from "node:sea";
import * as NodeURL from "node:url";

import {
  claimRuntimeOverride,
  failRuntimeOverrideStartup,
  installedStateDir,
  isServerStartInvocation,
  markRuntimeOverrideTrialStarted,
  releaseRuntimeOverride,
  resolveActiveRuntimeOverride,
  runtimeOverrideEnv,
  RUNTIME_OVERRIDE_ENV_ACTIVE,
} from "@t3tools/shared/runtimeOverride";

import packageJson from "../package.json" with { type: "json" };
import { isEntrypoint } from "./entrypoint.ts";

function resolveForegroundStateDir(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): string {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-dir" && argv[i + 1]) {
      return installedStateDir(NodePath.resolve(argv[i + 1]!));
    }
    if (arg?.startsWith("--base-dir=")) {
      return installedStateDir(NodePath.resolve(arg.slice("--base-dir=".length)));
    }
  }
  const fromEnv = env.T3CODE_HOME?.trim();
  return installedStateDir(
    fromEnv ? NodePath.resolve(fromEnv) : NodePath.join(NodeOS.homedir(), ".t3"),
  );
}

// A dev server runs from source with its own state dir; it never boots a custom build.
function isDevServerInvocation(argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv): boolean {
  return (
    Boolean(env.VITE_DEV_SERVER_URL?.trim()) ||
    argv.some((arg) => arg === "--dev-url" || arg.startsWith("--dev-url="))
  );
}

// Loads the CLI outside the launcher's module graph. Packaged builds embed it as a raw asset.
async function loadCliMain(): Promise<typeof import("./binMain.ts")> {
  const argv = process.argv.slice(2);
  const stateDir = resolveForegroundStateDir(argv, process.env);
  if (
    process.env[RUNTIME_OVERRIDE_ENV_ACTIVE] !== "1" &&
    isServerStartInvocation(argv) &&
    !isDevServerInvocation(argv, process.env)
  ) {
    const resolved = resolveActiveRuntimeOverride({
      stateDir,
      currentVersion: packageJson.version,
      env: process.env,
      argv,
    });
    // A client-only build has no server to load: the stock server reads its folder per request.
    if (resolved.status === "override" && resolved.override.entryPath !== undefined) {
      markRuntimeOverrideTrialStarted(stateDir);
      Object.assign(process.env, runtimeOverrideEnv(resolved.override));
    }
  }
  const overrideEntry = claimRuntimeOverride(
    process.env,
    NodeSea.isSea() ? NodePath.dirname(process.execPath) : import.meta.dirname,
  )?.entryPath;

  if (overrideEntry) {
    // A single executable can only import() built-ins, but its require() loads files from disk.
    const imported = (
      NodeSea.isSea()
        ? NodeModule.createRequire(import.meta.url)(overrideEntry)
        : await import(NodeURL.pathToFileURL(overrideEntry).href)
    ) as { readonly runCliCommand?: (typeof import("./binMain.ts"))["runCliCommand"] };
    if (typeof imported.runCliCommand === "function") {
      return { runCliCommand: imported.runCliCommand };
    }
    // Stock must not keep serving the custom client beside its own server.
    failRuntimeOverrideStartup({
      stateDir,
      currentVersion: packageJson.version,
      message: "Custom build has no CLI entry point; fell back to stock T3 Code.",
    });
    releaseRuntimeOverride();
  }

  if (!NodeSea.isSea()) return import("./binMain.ts");

  // Keep the executable's module URL so the CLI finds the web client and native packages beside it.
  const require = NodeModule.createRequire(import.meta.url);
  // require() resolves links in the executable path, such as a Windows junction.
  const cliUrl = NodeURL.pathToFileURL(require.resolve(process.execPath)).href;
  const hook = NodeModule.registerHooks({
    load(url, context, next) {
      if (url !== cliUrl) return next(url, context);
      return {
        format: "module",
        source: new Uint8Array(NodeSea.getRawAsset("binMain.mjs")),
        shortCircuit: true,
      };
    },
  });
  try {
    return require(process.execPath) as typeof import("./binMain.ts");
  } finally {
    hook.deregister();
  }
}

function ignoreOutputError(): void {}

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Logs go to stdout and stderr, which may be a closed desktop launcher pipe or a log file on
  // a full disk. Node emits a failed write as an unhandled stream error that crashes the process
  // and skips shutdown, so drop the line instead.
  process.stdout.on("error", ignoreOutputError);
  process.stderr.on("error", ignoreOutputError);

  // The launcher owns shutdown until its child exits, so it bypasses the Effect CLI runtime.
  // A service unit passes nothing, or on Windows the launcher's own flags; help and anything
  // else go through the full CLI.
  const launcher =
    process.argv[2] === "__service-launcher" ? await import("./cli/serviceLauncher.ts") : undefined;
  const launcherOptions = launcher?.parseServiceLauncherArgs(process.argv.slice(3));
  if (launcher !== undefined && launcherOptions !== undefined) {
    await launcher.runServiceLauncherCli(launcherOptions);
  } else if (process.argv[2] === "__process-launcher") {
    // Single executables host the launcher here; other builds start process-launcher.mjs directly.
    const { runProcessLauncher } = await import("./process/processLauncherWorker.ts");
    runProcessLauncher();
  } else {
    const { runCliCommand } = await loadCliMain();
    await runCliCommand();
  }
}
