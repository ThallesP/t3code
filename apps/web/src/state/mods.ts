import type { EnvironmentId, ModsStatusResult } from "@t3tools/contracts";
import { ModBuildInstallResult } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  type AtomCommand,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { reloadAfterRestart, reloadWhenInterfaceChanges } from "../lib/interfaceReload";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { localEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";
import { readPreparedConnection } from "./session";

/**
 * A mod is built on the machine its thread runs on. Every other machine this app is connected
 * to gets a copy of the finished build, carried by this app: it downloads the build from the
 * one machine and uploads it to the other, so the two never need to reach each other.
 */

const EXCLUDED_STORAGE_KEY = "t3code:mods:excluded-machines";
const DISMISSED_REPAIRS_STORAGE_KEY = "t3code:mods:dismissed-repairs";
const decodeInstallResult = Schema.decodeUnknownOption(
  Schema.fromJsonString(ModBuildInstallResult),
);
const decodeNames = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeNames = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const readNames = (key: string): ReadonlyArray<string> => {
  try {
    return Option.getOrElse(decodeNames(localStorage.getItem(key)), () => []);
  } catch {
    return [];
  }
};

const writeNames = (key: string, names: ReadonlyArray<string>) => {
  try {
    localStorage.setItem(key, encodeNames(names));
  } catch {
    // Private windows refuse storage; the choice then lasts for this page only.
  }
};

/** Machines the user chose to leave out when a mod is applied. Everything else gets it. */
export const excludedModMachinesAtom = Atom.make<ReadonlyArray<string>>(
  readNames(EXCLUDED_STORAGE_KEY),
).pipe(Atom.keepAlive, Atom.withLabel("web-mods:excluded-machines"));

/** Mods the user was told need repair and waved away. */
export const dismissedModRepairsAtom = Atom.make<ReadonlyArray<string>>(
  readNames(DISMISSED_REPAIRS_STORAGE_KEY),
).pipe(Atom.keepAlive, Atom.withLabel("web-mods:dismissed-repairs"));

export function dismissModRepairs(modIds: ReadonlyArray<string>): void {
  const next = [...new Set([...appAtomRegistry.get(dismissedModRepairsAtom), ...modIds])];
  appAtomRegistry.set(dismissedModRepairsAtom, next);
  writeNames(DISMISSED_REPAIRS_STORAGE_KEY, next);
}

export function setModMachineIncluded(environmentId: EnvironmentId, included: boolean): void {
  const others = appAtomRegistry
    .get(excludedModMachinesAtom)
    .filter((excluded) => excluded !== environmentId);
  const next = included ? others : [...others, environmentId];
  appAtomRegistry.set(excludedModMachinesAtom, next);
  writeNames(EXCLUDED_STORAGE_KEY, next);
}

/** What each connected machine has applied, as of its last answer. */
export const modStatusesAtom = Atom.make<ReadonlyMap<EnvironmentId, ModsStatusResult>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("web-mods:statuses"));

export type ModMachineStep = "copying" | "waiting" | "restarting";

/** What a rollout is doing on each machine right now. */
export const modMachineStepsAtom = Atom.make<ReadonlyMap<EnvironmentId, ModMachineStep>>(
  new Map(),
).pipe(Atom.keepAlive, Atom.withLabel("web-mods:machine-steps"));

/** Why the last rollout stopped on a machine. */
export const modMachineFailuresAtom = Atom.make<ReadonlyMap<EnvironmentId, string>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-mods:machine-failures"),
);

const setEntry = <A>(
  atom: Atom.Writable<ReadonlyMap<EnvironmentId, A>>,
  environmentId: EnvironmentId,
  value: A | null,
) => {
  const next = new Map(appAtomRegistry.get(atom));
  if (value === null) next.delete(environmentId);
  else next.set(environmentId, value);
  appAtomRegistry.set(atom, next);
};

const failureText = (failure: unknown) =>
  typeof failure === "object" &&
  failure !== null &&
  "message" in failure &&
  typeof failure.message === "string" &&
  failure.message.trim().length > 0
    ? failure.message
    : m(msg("That machine did not answer."));

async function run<W, A, E>(
  command: AtomCommand<W, A, E>,
  value: W,
): Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly message: string }
> {
  const result = await runAtomCommand(appAtomRegistry, command, value, { reportFailure: false });
  return result._tag === "Success"
    ? { ok: true, value: result.value }
    : { ok: false, message: failureText(squashAtomCommandFailure(result)) };
}

async function refreshModStatus(environmentId: EnvironmentId): Promise<ModsStatusResult | null> {
  const status = await run(serverEnvironment.modsStatus, { environmentId, input: {} });
  if (!status.ok) return null;
  const next = new Map(appAtomRegistry.get(modStatusesAtom));
  next.set(environmentId, status.value);
  appAtomRegistry.set(modStatusesAtom, next);
  return status.value;
}

/** True for a machine that can take a copy of a build: connected, and new enough to. */
function takesModBuilds(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.serverConfig
      ?.environment.capabilities.modBuildTransfer === true
  );
}

/**
 * Copies the build `source` has applied to `target`. Resolves with what to tell the user when it
 * could not, and with `null` once that machine has the build.
 */
async function copyBuild(source: EnvironmentId, target: EnvironmentId): Promise<string | null> {
  try {
    const [from, to] = await Promise.all([refreshModStatus(source), refreshModStatus(target)]);
    const sourceUrl = readPreparedConnection(source)?.httpBaseUrl;
    const targetUrl = readPreparedConnection(target)?.httpBaseUrl;
    if (from === null || to === null || sourceUrl === undefined || targetUrl === undefined) {
      return m(msg("That machine is not connected right now."));
    }
    if (from.build === null) return m(msg("There is no applied mod to copy."));
    if (to.build?.buildId === from.build.buildId) return null;
    if (to.serverVersion !== from.serverVersion) {
      return m(
        msg("It runs T3 Code {version}. Update it to {wanted} first.", {
          version: to.serverVersion,
          wanted: from.serverVersion,
        }),
      );
    }

    const offer = await run(serverEnvironment.modsOfferBuild, {
      environmentId: target,
      input: { clientFiles: from.build.clientFiles },
    });
    if (!offer.ok) return offer.message;
    const pack = await run(serverEnvironment.modsPackBuild, {
      environmentId: source,
      input: { buildId: from.build.buildId, clientFiles: offer.value.missingClientFiles },
    });
    if (!pack.ok) return pack.message;
    const downloadUrl = resolveAssetUrl(sourceUrl, pack.value.downloadUrl);
    const uploadUrl = resolveAssetUrl(targetUrl, offer.value.uploadUrl);
    if (downloadUrl === null || uploadUrl === null) return m(msg("That machine did not answer."));

    const downloaded = await fetch(downloadUrl);
    if (!downloaded.ok)
      return m(msg("Could not download the mod from the machine it was made on."));
    const uploaded = await fetch(uploadUrl, { method: "POST", body: await downloaded.blob() });
    const answer = await uploaded.text();
    if (!uploaded.ok || Option.isNone(decodeInstallResult(answer))) {
      return answer.trim().length > 0 && answer.length < 300
        ? answer
        : m(msg("That machine could not take the mod."));
    }
    await refreshModStatus(target);
    return null;
  } catch {
    return m(msg("That machine did not answer."));
  }
}

const RESTART_POLL_MS = 1_500;
const RESTART_WAIT_MS = 120_000;
// A machine that was already restarting by itself drops the request; it is back well within this.
const RESTART_UNCONFIRMED_WAIT_MS = 30_000;
const SETTLE_POLL_MS = 5_000;

/**
 * Asks a machine's T3 Code to restart and waits for it to come back on the applied build.
 * Resolves with what to tell the user on failure.
 */
async function restartServer(environmentId: EnvironmentId): Promise<string | null> {
  const restarted = await run(serverEnvironment.modsRestart, { environmentId, input: {} });
  const deadline = Date.now() + (restarted.ok ? RESTART_WAIT_MS : RESTART_UNCONFIRMED_WAIT_MS);
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
    // No answer while it is down, and the old answer until the connection is new.
    if ((await refreshModStatus(environmentId))?.restartPending === false) return null;
  }
  return restarted.ok ? m(msg("It did not come back yet. Check that machine.")) : restarted.message;
}

/**
 * Brings the build `source` has applied to each of `targets`: copies it to the ones that lack it,
 * then restarts every one that must restart to switch to it. What it is doing and where it
 * stopped shows in the two atoms above.
 */
export async function rollOutMod(input: {
  readonly source: EnvironmentId;
  readonly targets: ReadonlyArray<EnvironmentId>;
}): Promise<void> {
  for (const target of input.targets) {
    setEntry(modMachineFailuresAtom, target, null);
    if (target !== input.source) setEntry(modMachineStepsAtom, target, "copying");
  }
  await refreshModStatus(input.source);
  const waitsToRestart = (target: EnvironmentId) =>
    appAtomRegistry.get(modStatusesAtom).get(target)?.restartPending === true ? "waiting" : null;
  const ready = (
    await Promise.all(
      input.targets.map(async (target) => {
        if (target === input.source) setEntry(modMachineStepsAtom, target, waitsToRestart(target));
        const failed = target === input.source ? null : await copyBuild(input.source, target);
        setEntry(modMachineFailuresAtom, target, failed);
        setEntry(modMachineStepsAtom, target, failed === null ? waitsToRestart(target) : null);
        return failed === null ? [target] : [];
      }),
    )
  ).flat();

  await restartModMachines(ready);
}

/** Restarts each of `targets` that must restart to run the mods applied there. */
export async function restartModMachines(targets: ReadonlyArray<EnvironmentId>): Promise<void> {
  const servesThisPage = appAtomRegistry.get(localEnvironmentIdAtom);
  const restart = async (target: EnvironmentId) => {
    // A machine with nothing running restarts by itself, and may have done so by now.
    const status =
      (await refreshModStatus(target)) ?? appAtomRegistry.get(modStatusesAtom).get(target);
    if (status?.restartPending === true && status.canRestart) {
      setEntry(modMachineStepsAtom, target, "restarting");
      setEntry(modMachineFailuresAtom, target, await restartServer(target));
    }
    setEntry(modMachineStepsAtom, target, null);
  };
  // The machine that serves this page goes last: the reload that shows the mods ends this work.
  await Promise.all(targets.filter((target) => target !== servesThisPage).map(restart));
  if (servesThisPage !== null && targets.includes(servesThisPage)) {
    // Until it restarts it serves its plain interface, which is not one to reload for.
    if ((await refreshModStatus(servesThisPage))?.restartPending === true) {
      void reloadAfterRestart(RESTART_WAIT_MS);
    }
    await restart(servesThisPage);
    // For a mod that needed no restart, and for a restart too quick to be seen.
    void reloadWhenInterfaceChanges(0);
  }
}

type ModRef = NonNullable<ModsStatusResult["build"]>["mods"][number];

const holds = (mods: ReadonlyArray<ModRef>, mod: ModRef) =>
  mods.some(
    (other) =>
      other.id === mod.id &&
      other.patchSha256 !== undefined &&
      other.patchSha256 === mod.patchSha256,
  );

// One try per build and machine: a copy that failed is not sent again every few seconds.
const caughtUp = new Set<string>();

/**
 * After an update a machine that cannot rebuild its mods itself gets the build of a machine
 * that rebuilt them: each of its mods is in that build, or was left out of it as one that no
 * longer fits. It restarts itself into the build once nothing runs there.
 */
async function catchUp(target: EnvironmentId, status: ModsStatusResult): Promise<void> {
  const paused = status.paused;
  if (paused === undefined || paused.rebuilding) return;
  if (appAtomRegistry.get(excludedModMachinesAtom).includes(target)) return;
  const source = [...appAtomRegistry.get(modStatusesAtom)].find(
    ([environmentId, other]) =>
      environmentId !== target &&
      other.serverVersion === status.serverVersion &&
      other.build !== null &&
      paused.mods.every(
        (mod) => holds(other.build?.mods ?? [], mod) || holds(other.needsRepair ?? [], mod),
      ),
  );
  const buildId = source?.[1].build?.buildId;
  if (source === undefined || buildId === undefined) return;
  if (caughtUp.has(`${target}:${buildId}`)) return;
  caughtUp.add(`${target}:${buildId}`);
  setEntry(modMachineStepsAtom, target, "copying");
  setEntry(modMachineFailuresAtom, target, await copyBuild(source[0], target));
  setEntry(modMachineStepsAtom, target, null);
}

/** True while a machine still has something to do before it runs the user's mods. */
const unsettled = (status: ModsStatusResult) =>
  status.paused !== undefined || status.restartPending;

/**
 * Asks each machine what it has applied once it is connected, and again after it reconnects.
 * One that is not settled yet, as after an update, is asked again until it is.
 */
export function startModSync(): void {
  const asked = new Map<EnvironmentId, ReturnType<typeof setTimeout> | null>();
  const forget = (environmentId: EnvironmentId) => {
    clearTimeout(asked.get(environmentId) ?? undefined);
    asked.delete(environmentId);
  };
  const ask = (environmentId: EnvironmentId) => {
    asked.set(environmentId, null);
    void refreshModStatus(environmentId).then((status) => {
      if (!asked.has(environmentId)) return;
      // Not connected far enough yet: the next change to the list asks again.
      if (status === null) return forget(environmentId);
      // Its interface changes without this page asking when it rebuilds or restarts by itself.
      if (environmentId === appAtomRegistry.get(localEnvironmentIdAtom)) {
        void reloadWhenInterfaceChanges(0);
      }
      if (!unsettled(status)) return;
      void catchUp(environmentId, status);
      asked.set(
        environmentId,
        setTimeout(() => ask(environmentId), SETTLE_POLL_MS),
      );
    });
  };
  appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    (presentations) => {
      for (const [environmentId, presentation] of presentations) {
        if (presentation.connection.phase !== "connected") {
          forget(environmentId);
          continue;
        }
        if (asked.has(environmentId) || !takesModBuilds(environmentId)) continue;
        if (readPreparedConnection(environmentId) === null) continue;
        ask(environmentId);
      }
    },
    { immediate: true },
  );
}
