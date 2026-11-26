import { EnvironmentId, type ModsStatusResult } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const DEV = EnvironmentId.make("environment:dev");
const MAC = EnvironmentId.make("environment:mac");
const NAS = EnvironmentId.make("environment:nas");

const state = vi.hoisted(() => ({
  machines: new Map<string, ModsStatusResult>(),
  /** Machines whose upload is refused. */
  refuses: new Set<string>(),
  servesThisPage: "environment:mac",
  log: [] as Array<string>,
  presentations: null as Atom.Writable<ReadonlyMap<string, unknown>> | null,
}));

vi.mock("../i18n/messages", () => ({ m: (message: string) => message }));
vi.mock("gt-react", () => ({ msg: (message: string) => message }));
vi.mock("../lib/interfaceReload", () => ({
  reloadAfterRestart: async () => {
    state.log.push("reload after the restart");
    return true;
  },
  reloadWhenInterfaceChanges: async () => {
    state.log.push("reload if the interface changed");
    return true;
  },
}));
vi.mock("./presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  state.presentations = Atom.make<ReadonlyMap<string, unknown>>(new Map());
  return { environmentPresentations: { presentationsAtom: state.presentations } };
});
vi.mock("./primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { localEnvironmentIdAtom: Atom.make(() => state.servesThisPage) };
});
vi.mock("./session", () => ({
  readPreparedConnection: (environmentId: string) => ({ httpBaseUrl: `${environmentId}|` }),
}));
vi.mock("./server", () => ({
  serverEnvironment: {
    modsStatus: "status",
    modsOfferBuild: "offer",
    modsPackBuild: "pack",
    modsRestart: "restart",
  },
}));
vi.mock("@t3tools/client-runtime/state/assets", () => ({
  resolveAssetUrl: (base: string, path: string) => `${base}${path}`,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: () => ({ message: "It refused." }),
  runAtomCommand: async (_registry: unknown, command: string, value: { environmentId: string }) => {
    const machine = state.machines.get(value.environmentId);
    if (machine === undefined) return AsyncResult.failure(null as never);
    if (command === "status") return AsyncResult.success(structuredClone(machine));
    if (command === "offer") {
      return AsyncResult.success({ missingClientFiles: [], uploadUrl: "/upload" });
    }
    if (command === "pack") return AsyncResult.success({ downloadUrl: "/download" });
    state.log.push(`restart ${value.environmentId}`);
    state.machines.set(value.environmentId, { ...machine, restartPending: false });
    return AsyncResult.success(undefined);
  },
}));

const build = {
  buildId: "mod-1",
  baseVersion: "1.0.0",
  artifactSha256: "a",
  restartRequired: true,
  clientFiles: [],
  mods: [],
};
const running = (applied: boolean): ModsStatusResult => ({
  serverVersion: "1.0.0",
  build: applied ? build : null,
  restartPending: applied,
  canRestart: true,
});

beforeEach(() => {
  vi.useFakeTimers();
  state.log.length = 0;
  state.refuses.clear();
  state.machines = new Map([
    [DEV, running(true)],
    [MAC, running(false)],
    [NAS, running(false)],
  ]);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    if (init?.method !== "POST") return new Response("pack");
    const environmentId = EnvironmentId.make(url.split("|")[0] ?? "");
    if (state.refuses.has(environmentId)) {
      return new Response("Its disk is full.", { status: 422 });
    }
    state.log.push(`copy to ${environmentId}`);
    state.machines.set(environmentId, running(true));
    return new Response(JSON.stringify({ buildId: build.buildId, restartRequired: true }));
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("copies a mod to every machine, then restarts each, the one serving this page last", async () => {
  const { rollOutMod } = await import("./mods");

  const done = rollOutMod({ source: DEV, targets: [DEV, MAC, NAS] });
  await vi.runAllTimersAsync();
  await done;

  expect(state.log.slice(0, 2).toSorted()).toEqual([`copy to ${MAC}`, `copy to ${NAS}`]);
  expect(state.log.slice(2, 4).toSorted()).toEqual([`restart ${DEV}`, `restart ${NAS}`]);
  expect(state.log.slice(4)).toEqual([
    "reload after the restart",
    `restart ${MAC}`,
    "reload if the interface changed",
  ]);
});

it("leaves a machine that could not take the mod alone and says why", async () => {
  const { modMachineFailuresAtom, modMachineStepsAtom, rollOutMod } = await import("./mods");
  const { appAtomRegistry } = await import("../rpc/atomRegistry");
  state.refuses.add(NAS);

  const done = rollOutMod({ source: DEV, targets: [DEV, NAS] });
  await vi.runAllTimersAsync();
  await done;

  expect(state.log).toEqual([`restart ${DEV}`]);
  expect(appAtomRegistry.get(modMachineFailuresAtom).get(NAS)).toBe("Its disk is full.");
  expect(appAtomRegistry.get(modMachineStepsAtom).size).toBe(0);
});

it("after an update, hands a machine that cannot rebuild its mods the build of one that did", async () => {
  const { startModSync } = await import("./mods");
  const { appAtomRegistry } = await import("../rpc/atomRegistry");
  const mod = { id: "hide-issues", title: "Hide the Issues button", patchSha256: "a" };
  state.machines = new Map([
    [DEV, { ...running(true), restartPending: false, build: { ...build, mods: [mod] } }],
    [MAC, { ...running(false), paused: { mods: [mod], rebuilding: false } }],
    // Its own mods are not the ones dev rebuilt, so dev's build would take one away.
    [
      NAS,
      { ...running(false), paused: { mods: [{ ...mod, patchSha256: "b" }], rebuilding: false } },
    ],
  ]);
  const connected = {
    connection: { phase: "connected" },
    serverConfig: { environment: { capabilities: { modBuildTransfer: true } } },
  };

  startModSync();
  appAtomRegistry.set(
    state.presentations!,
    new Map([
      [DEV, connected],
      [MAC, connected],
      [NAS, connected],
    ]),
  );
  await vi.advanceTimersByTimeAsync(12_000);

  expect(state.log.filter((entry) => entry.startsWith("copy"))).toEqual([`copy to ${MAC}`]);
  // The Mac serves this page, so the page looks for its new interface each time it asks.
  expect(state.log).toContain("reload if the interface changed");
});
