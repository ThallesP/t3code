import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as ModService from "../mods/ModService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { baseDirFlag, resolveCliAuthConfig } from "./config.ts";

const sourceDirFlag = Flag.String("source").pipe(
  Flag.withDescription("Path to a local T3 Code git checkout."),
  Flag.optional,
);

const withModService = Effect.fn("cli.mod.withModService")(function* <A, E>(
  baseDir: Option.Option<string>,
  program: (service: ModService.ModService["Service"]) => Effect.Effect<A, E>,
) {
  const config = yield* resolveCliAuthConfig({ baseDir }, yield* GlobalFlag.LogLevel, {
    quietLogs: true,
  });
  return yield* ModService.ModService.pipe(
    Effect.flatMap(program),
    Effect.provide(
      ModService.layer.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(ProcessRunner.layer),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.scoped,
  );
});

const modStatusCommand = Command.make("status", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Show active local runtime override, fallback notice, and saved mods."),
  Command.withHandler(({ baseDir }) =>
    withModService(baseDir, (mods) =>
      Effect.gen(function* () {
        const snapshot = yield* mods.status();
        yield* Console.log(`T3 Code version: ${snapshot.currentVersion}`);
        if (snapshot.activeOverride !== null) {
          yield* Console.log(
            `Active override: ${snapshot.activeOverride.buildId} (base ${snapshot.activeOverride.baseVersion}, sha ${snapshot.activeOverride.artifactSha256.slice(0, 12)})`,
          );
        } else {
          yield* Console.log("Active override: none (running stock T3 Code)");
        }
        if (snapshot.fallback !== null) {
          yield* Console.log(
            `Fallback notice [${snapshot.fallback.reason}]: ${snapshot.fallback.message}`,
          );
        }
        yield* Console.log(`Saved mods: ${snapshot.mods.length}`);
        for (const mod of snapshot.mods) {
          const state = mod.metadata.enabled ? "enabled" : "disabled";
          const tamper = mod.verifyTampered ? " [verify.ts modified!]" : "";
          yield* Console.log(
            `  - ${mod.metadata.id} (${state}, base ${mod.metadata.baseVersion})${tamper}: ${mod.metadata.title}`,
          );
        }
      }),
    ),
  ),
);

const modDisableCommand = Command.make("disable", { baseDir: baseDirFlag }).pipe(
  Command.withDescription("Disable the active runtime override and return to stock T3 Code."),
  Command.withHandler(({ baseDir }) =>
    withModService(baseDir, (mods) =>
      Effect.gen(function* () {
        const { restartRequired } = yield* mods.disableAll();
        yield* Console.log(
          restartRequired
            ? "Turned every mod off. Restart T3 Code to run stock."
            : "Turned every mod off. Reload T3 Code to see stock.",
        );
      }),
    ),
  ),
);

const modUpgradeCommand = Command.make("upgrade", {
  baseDir: baseDirFlag,
  source: sourceDirFlag,
}).pipe(
  Command.withDescription(
    "Replay enabled local mods against the current T3 Code source using pinned verify.ts checks.",
  ),
  Command.withHandler(({ baseDir, source }) =>
    withModService(baseDir, (mods) =>
      Effect.gen(function* () {
        const results = yield* mods.checkUpgrade({ sourceDir: Option.getOrUndefined(source) });
        if (results.length === 0) {
          yield* Console.log("No enabled local mods to check.");
          return;
        }
        for (const entry of results) {
          yield* Console.log(`[${entry.status}] ${entry.id} (${entry.title}): ${entry.detail}`);
        }
      }),
    ),
  ),
);

const modExportCommand = Command.make("export", {
  baseDir: baseDirFlag,
  id: Argument.String("id"),
  destination: Argument.String("destination"),
}).pipe(
  Command.withDescription("Export a portable mod folder to share without a GitHub fork."),
  Command.withHandler(({ baseDir, id, destination }) =>
    withModService(baseDir, (mods) =>
      Effect.gen(function* () {
        const { exportedDir } = yield* mods.exportMod({ id, destinationDir: destination });
        yield* Console.log(`Exported mod "${id}" to ${exportedDir}`);
      }),
    ),
  ),
);

const modImportCommand = Command.make("import", {
  baseDir: baseDirFlag,
  dir: Argument.String("dir"),
}).pipe(
  Command.withDescription(
    "Import a shared mod folder. It stays off until you ask an agent to apply it.",
  ),
  Command.withHandler(({ baseDir, dir }) =>
    withModService(baseDir, (mods) =>
      Effect.gen(function* () {
        const imported = yield* mods.importMod({ sourceModDir: dir });
        yield* Console.log(
          `Imported mod "${imported.metadata.id}" (${imported.metadata.title}) into ${imported.dirPath}. It is off until you ask an agent to apply it.`,
        );
      }),
    ),
  ),
);

export const modCommand = Command.make("mod").pipe(
  Command.withDescription("Inspect, verify, share, and roll back local T3 Code customizations."),
  Command.withSubcommands([
    modStatusCommand,
    modDisableCommand,
    modUpgradeCommand,
    modExportCommand,
    modImportCommand,
  ]),
);
