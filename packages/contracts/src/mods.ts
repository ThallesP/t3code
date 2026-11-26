import * as Schema from "effect/Schema";

const ModName = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  /** Names the change itself: two machines hold the same mod when this is the same. */
  patchSha256: Schema.optionalKey(Schema.String),
});

/** The build of the user's mods a machine has applied. */
export const ModBuildStatus = Schema.Struct({
  buildId: Schema.String,
  baseVersion: Schema.String,
  artifactSha256: Schema.String,
  /** True when the build changes the server, so it only runs after a restart. */
  restartRequired: Schema.Boolean,
  /** The build's interface files, for another machine to say which it lacks. */
  clientFiles: Schema.Array(Schema.String),
  mods: Schema.Array(ModName),
});
export type ModBuildStatus = typeof ModBuildStatus.Type;

export const ModsStatusResult = Schema.Struct({
  serverVersion: Schema.String,
  build: Schema.NullOr(ModBuildStatus),
  /** The applied build is not what this server runs yet. */
  restartPending: Schema.Boolean,
  /** This server can restart itself when asked. */
  canRestart: Schema.Boolean,
  /** Approved mods an update left out of what runs. Absent when there are none. */
  paused: Schema.optionalKey(
    Schema.Struct({
      mods: Schema.Array(ModName),
      /** This machine is building them again itself. Otherwise it waits for a copy. */
      rebuilding: Schema.Boolean,
      /** Why its own build of them failed. */
      failure: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Mods an update turned off because they no longer fit this version. */
  needsRepair: Schema.optionalKey(Schema.Array(ModName)),
});
export type ModsStatusResult = typeof ModsStatusResult.Type;

/** Sent to the machine that is to receive a build. */
export const ModsOfferBuildInput = Schema.Struct({
  clientFiles: Schema.Array(Schema.String),
});
export type ModsOfferBuildInput = typeof ModsOfferBuildInput.Type;

export const ModsOfferBuildResult = Schema.Struct({
  missingClientFiles: Schema.Array(Schema.String),
  /** Where to PUT the packed build. Signed, short-lived and relative to that machine's address. */
  uploadUrl: Schema.String,
});
export type ModsOfferBuildResult = typeof ModsOfferBuildResult.Type;

/** Sent to the machine the build was made on. */
export const ModsPackBuildInput = Schema.Struct({
  buildId: Schema.String,
  clientFiles: Schema.Array(Schema.String),
});
export type ModsPackBuildInput = typeof ModsPackBuildInput.Type;

export const ModsPackBuildResult = Schema.Struct({
  /** Where to GET the packed build. Signed, short-lived and relative to that machine's address. */
  downloadUrl: Schema.String,
});
export type ModsPackBuildResult = typeof ModsPackBuildResult.Type;

/** The body a machine answers an uploaded build with. */
export const ModBuildInstallResult = Schema.Struct({
  buildId: Schema.String,
  restartRequired: Schema.Boolean,
});
export type ModBuildInstallResult = typeof ModBuildInstallResult.Type;

export class ModsRequestError extends Schema.TaggedError<ModsRequestError>()("ModsRequestError", {
  message: Schema.String,
}) {}
