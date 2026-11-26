import {
  ModBuildInstallResult,
  type ModsOfferBuildInput,
  type ModsOfferBuildResult,
  type ModsPackBuildInput,
  type ModsPackBuildResult,
  ModsRequestError,
  type ModsStatusResult,
} from "@t3tools/contracts";
import {
  claimedRuntimeOverride,
  computeTextSha256,
  isStockModeRequested,
  modsPaths,
  readRuntimeOverridePointer,
  type RuntimeOverridePointer,
} from "@t3tools/shared/runtimeOverride";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../../package.json" with { type: "json" };
import * as AssetSigner from "../assets/AssetSigner.ts";
import { base64UrlDecodeUtf8, base64UrlEncode } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { restartAnywhere } from "../serverRestart.ts";
import { forkParked } from "../serverActivation.ts";
import * as ModService from "./ModService.ts";

const PACK_ROUTE_PREFIX = "/api/mods/pack";
const INSTALL_ROUTE_PREFIX = "/api/mods/install";
const URL_TTL_MS = 10 * 60_000;
const PACK_ID_PATTERN = /^[0-9a-f-]{36}$/;

const Claims = Schema.Struct({
  kind: Schema.Literals(["mod-pack", "mod-install"]),
  /** The packed file a download serves. */
  packId: Schema.optionalKey(Schema.String),
  expiresAt: Schema.Number,
});
type Claims = typeof Claims.Type;
const claimsJson = Schema.fromJsonString(Claims);
const encodeClaims = Schema.encodeSync(claimsJson);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);
const encodeInstallResult = Schema.encodeSync(Schema.fromJsonString(ModBuildInstallResult));

const requestFailed = (error: { readonly message: string }) =>
  new ModsRequestError({ message: error.message });

/**
 * Copies a build of the user's mods between machines. The client that is connected to both
 * carries it: it downloads the pack from the machine that built it and uploads it to the other,
 * so the two machines never need to reach each other.
 */
export class ModBuildTransfer extends Context.Service<
  ModBuildTransfer,
  {
    readonly status: Effect.Effect<ModsStatusResult, ModsRequestError>;
    readonly offerBuild: (
      input: ModsOfferBuildInput,
    ) => Effect.Effect<ModsOfferBuildResult, ModsRequestError>;
    readonly packBuild: (
      input: ModsPackBuildInput,
    ) => Effect.Effect<ModsPackBuildResult, ModsRequestError>;
    readonly restart: Effect.Effect<void, ModsRequestError>;
  }
>()("t3/mods/ModBuildTransfer") {}

const signedUrl = Effect.fn("ModBuildTransfer.signedUrl")(function* (
  prefix: string,
  claims: Omit<Claims, "expiresAt">,
) {
  const signer = yield* AssetSigner.AssetSigner;
  const payload = base64UrlEncode(
    encodeClaims({ ...claims, expiresAt: (yield* Clock.currentTimeMillis) + URL_TTL_MS }),
  );
  const signature = yield* signer
    .sign(payload)
    .pipe(Effect.mapError(() => new ModsRequestError({ message: "Could not sign the link." })));
  return `${prefix}/${payload}.${signature}`;
});

const readClaims = Effect.fn("ModBuildTransfer.readClaims")(function* (
  prefix: string,
  kind: Claims["kind"],
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const pathname = request.url.split("?")[0] ?? "";
  const [payload, signature, extra] = pathname.slice(`${prefix}/`.length).split(".");
  if (!payload || !signature || extra) return null;
  const signer = yield* AssetSigner.AssetSigner;
  if (!(yield* signer.verify(payload, signature).pipe(Effect.orElseSucceed(() => false)))) {
    return null;
  }
  const claims = Option.getOrNull(
    Option.liftThrowable(base64UrlDecodeUtf8)(payload).pipe(Option.flatMap(decodeClaims)),
  );
  if (claims === null || claims.kind !== kind) return null;
  return claims.expiresAt > (yield* Clock.currentTimeMillis) ? claims : null;
});

/** The applied build is not what this server runs. */
const restartPending = (applied: RuntimeOverridePointer | null) => {
  const running = claimedRuntimeOverride();
  return applied === null || applied.baseVersion !== packageJson.version
    ? running !== null
    : (running?.entryPath ?? null) !== (applied.entryPath ?? null);
};

const packsDir = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(modsPaths(config.stateDir).modsDir, "packs");
});

const make = Effect.gen(function* () {
  const modService = yield* ModService.ModService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const signer = yield* AssetSigner.AssetSigner;
  const restart = yield* restartAnywhere;
  const packs = yield* packsDir.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(Path.Path, path),
  );
  // Packs are deleted as they are downloaded; these are the ones nobody came for.
  yield* fs.remove(packs, { recursive: true, force: true }).pipe(Effect.ignore);

  const named = (mods: ReadonlyArray<ModService.SavedModRecord>) =>
    mods.map((mod) => ({
      id: mod.metadata.id,
      title: mod.metadata.title,
      patchSha256: computeTextSha256(mod.patchDiff),
    }));

  const status: ModBuildTransfer["Service"]["status"] = Effect.gen(function* () {
    const snapshot = yield* modService.status();
    const applied = snapshot.activeOverride;
    const needsRepair = snapshot.mods.filter((mod) => mod.metadata.needsRepair === true);
    const afterUpdate = {
      ...(snapshot.paused.length > 0
        ? {
            paused: {
              mods: named(snapshot.paused),
              rebuilding: snapshot.rebuilding,
              ...(snapshot.rebuildFailure !== null ? { failure: snapshot.rebuildFailure } : {}),
            },
          }
        : {}),
      ...(needsRepair.length > 0 ? { needsRepair: named(needsRepair) } : {}),
    };
    if (applied === null || applied.baseVersion !== packageJson.version) {
      return {
        serverVersion: packageJson.version,
        build: null,
        restartPending: restartPending(applied),
        canRestart: restart !== null,
        ...afterUpdate,
      };
    }
    const described = yield* modService.describeBuild({ buildId: applied.buildId });
    return {
      ...afterUpdate,
      serverVersion: packageJson.version,
      build: {
        buildId: applied.buildId,
        baseVersion: applied.baseVersion,
        artifactSha256: applied.artifactSha256,
        restartRequired: described.restartRequired,
        clientFiles: described.clientFiles,
        mods: described.mods,
      },
      restartPending: restartPending(applied),
      canRestart: restart !== null,
    };
  }).pipe(Effect.mapError(requestFailed));

  return ModBuildTransfer.of({
    status,
    offerBuild: Effect.fn("ModBuildTransfer.offerBuild")(function* (input) {
      return {
        missingClientFiles: yield* modService.missingClientFiles(input.clientFiles),
        uploadUrl: yield* signedUrl(INSTALL_ROUTE_PREFIX, { kind: "mod-install" }).pipe(
          Effect.provideService(AssetSigner.AssetSigner, signer),
        ),
      };
    }),
    packBuild: Effect.fn("ModBuildTransfer.packBuild")(function* (input) {
      const packId = yield* random
        .uuidV4()
        .pipe(Effect.mapError(() => new ModsRequestError({ message: "Could not pack." })));
      yield* modService
        .packBuild({
          buildId: input.buildId,
          clientFiles: input.clientFiles,
          packPath: path.join(packs, packId),
        })
        .pipe(Effect.mapError(requestFailed));
      return {
        downloadUrl: yield* signedUrl(PACK_ROUTE_PREFIX, { kind: "mod-pack", packId }).pipe(
          Effect.provideService(AssetSigner.AssetSigner, signer),
        ),
      };
    }),
    restart:
      restart === null
        ? Effect.fail(
            new ModsRequestError({
              message: "This T3 Code cannot restart itself. Restart it on that machine.",
            }),
          )
        : // Reply before stopping: the restart closes this connection.
          restart.pipe(Effect.delay("500 millis"), Effect.forkDetach, Effect.asVoid),
  });
});

export const layer = Layer.effect(ModBuildTransfer, make);

const IDLE_CHECK_INTERVAL = Duration.seconds(10);

/**
 * A build that waits for a restart gets it once no thread is running, so nothing is cut off:
 * the mods an update rebuilt, or an Apply whose restart never happened.
 */
export const restartWhenIdleLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const restart = yield* restartAnywhere;
    // A server told to run stock never switches, however often it restarts.
    if (restart === null || isStockModeRequested(yield* HostProcess.Environment)) return;
    // One try per build: a start that does not switch to it must not restart again and again.
    const triedPath = path.join(modsPaths(config.stateDir).modsDir, "restarted-for");
    // Whoever applied the build usually restarts right away; this is for when nobody did.
    const seenWaiting = yield* Ref.make<string | null>(null);

    const restartIfIdle = Effect.gen(function* () {
      const applied = readRuntimeOverridePointer(config.stateDir);
      if (!restartPending(applied)) {
        yield* Ref.set(seenWaiting, null);
        return yield* fs.remove(triedPath, { force: true });
      }
      const wanted = applied?.buildId ?? "stock";
      if ((yield* Ref.getAndSet(seenWaiting, wanted)) !== wanted) return;
      const tried = yield* fs.readFileString(triedPath).pipe(Effect.orElseSucceed(() => ""));
      if (tried === wanted) return;
      const rows = yield* sql<{ readonly active: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs
          WHERE status IN ('preparing', 'starting', 'running')
        ) AS active
      `;
      if (rows[0]?.active === 1) return;
      yield* fs.writeFileString(triedPath, wanted);
      yield* Effect.logInfo("restarting to switch to the applied mods", { build: wanted });
      yield* restart;
    });

    yield* forkParked(
      restartIfIdle.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("could not restart into the applied mods", { cause }),
        ),
        Effect.repeat(Schedule.spaced(IDLE_CHECK_INTERVAL)),
      ),
    );
  }),
);

// Signed URLs carry their bearer token in the path; spans and request logs record it as REDACTED.
const SIGNED_URL_ROUTE_OPTIONS = { redactedParams: ["*"] };

const packRoute = HttpRouter.add(
  "GET",
  `${PACK_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const claims = yield* readClaims(PACK_ROUTE_PREFIX, "mod-pack");
    if (claims?.packId === undefined || !PACK_ID_PATTERN.test(claims.packId)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packPath = path.join(yield* packsDir, claims.packId);
    // The route's scope closes once the response is sent.
    yield* Effect.addFinalizer(() => fs.remove(packPath, { force: true }).pipe(Effect.ignore));
    return yield* HttpServerResponse.file(packPath, {
      headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("Not Found", { status: 404 })));
  }),
  SIGNED_URL_ROUTE_OPTIONS,
);

const installRoute = HttpRouter.add(
  "POST",
  `${INSTALL_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    if ((yield* readClaims(INSTALL_ROUTE_PREFIX, "mod-install")) === null) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const request = yield* HttpServerRequest.HttpServerRequest;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const modService = yield* ModService.ModService;
    const packPath = path.join(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-mod-pack-" }),
      "pack",
    );
    // Keep the request stream in the route scope until the response is sent.
    const bodyPull = yield* Stream.toPull(request.stream);
    yield* Stream.run(Stream.fromPull(Effect.succeed(bodyPull)), fs.sink(packPath));
    return yield* modService.installBuild({ packPath }).pipe(
      Effect.map((installed) =>
        HttpServerResponse.text(encodeInstallResult(installed), {
          contentType: "application/json",
        }),
      ),
      Effect.catch((error) =>
        Effect.succeed(HttpServerResponse.text(error.message, { status: 422 })),
      ),
    );
  }).pipe(
    Effect.orElseSucceed(() =>
      HttpServerResponse.text("Could not receive the build.", { status: 500 }),
    ),
  ),
  SIGNED_URL_ROUTE_OPTIONS,
);

export const routeLayer = Layer.mergeAll(packRoute, installRoute);
