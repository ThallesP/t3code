// @effect-diagnostics nodeBuiltinImport:off -- Replacing the process image has no Effect API.
import * as NodeSea from "node:sea";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import { ServerRestart } from "./persistence/DatabaseStorage.ts";

// Stop as a SIGTERM would: runMain's listener interrupts the server, so its shutdown path runs.
const stop = Effect.sync(() => void process.emit("SIGTERM"));

const isSupervised = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;
  // As in runServerCommand, only the desktop app passes a bootstrap token; `serve --mode desktop` by hand has no supervisor.
  const desktopLaunched = config.mode === "desktop" && config.desktopBootstrapToken !== undefined;
  return desktopLaunched || launcher.managed;
});

// The desktop app and the background service start the server again after it exits.
export const layer = Layer.effect(
  ServerRestart,
  isSupervised.pipe(Effect.map((supervised) => (supervised ? stop : null))),
);

/**
 * Restarts this server wherever it runs. One nothing supervises replaces itself with a fresh
 * copy once it has shut down, keeping its process id so whatever started it still finds it.
 * `null` on Windows, which cannot do that, and for a dev server, which its dev runner owns.
 */
export const restartAnywhere = Effect.gen(function* () {
  if (yield* isSupervised) return stop;
  const config = yield* ServerConfig.ServerConfig;
  if (typeof process.execve !== "function" || config.devUrl !== undefined) return null;
  return Effect.sync(() => {
    const args = NodeSea.isSea()
      ? process.argv.slice(2)
      : [...process.execArgv, ...process.argv.slice(1)];
    process.once("exit", () => {
      process.execve?.(process.execPath, [process.execPath, ...args], process.env);
    });
  }).pipe(Effect.andThen(stop));
});
