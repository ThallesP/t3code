import { EnvironmentId, type ModsStatusResult } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const DEV = EnvironmentId.make("environment:dev");
const MAC = EnvironmentId.make("environment:mac");

const state = vi.hoisted(() => ({
  statuses: new Map<string, unknown>(),
  running: 0,
  restart: vi.fn(),
  dismiss: vi.fn(),
}));

// Each atom is a name here, and reading one returns what the test set for it.
vi.mock("@effect/atom-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@effect/atom-react")>()),
  useAtomValue: (atom: string) =>
    atom === "statuses"
      ? state.statuses
      : atom === "steps"
        ? new Map()
        : atom === "dismissed"
          ? []
          : state.running,
}));
vi.mock("../../state/mods", () => ({
  modStatusesAtom: "statuses",
  modMachineStepsAtom: "steps",
  dismissedModRepairsAtom: "dismissed",
  restartModMachines: state.restart,
  dismissModRepairs: state.dismiss,
}));
vi.mock("./UpdateEverythingDialog", () => ({ runningThreadCountAtom: () => "running" }));

import { SidebarModsNotice } from "./SidebarModsNotice";

const mod = { id: "hide-issues", title: "Hide the Issues button", patchSha256: "a" };
const stock: ModsStatusResult = {
  serverVersion: "1.0.1",
  build: null,
  restartPending: false,
  canRestart: true,
};
const rebuilt: ModsStatusResult = {
  ...stock,
  build: {
    buildId: "update-1",
    baseVersion: "1.0.1",
    artifactSha256: "a",
    restartRequired: true,
    clientFiles: [],
    mods: [mod],
  },
  restartPending: true,
};

function show(statuses: ReadonlyArray<readonly [string, ModsStatusResult]>, running = 0) {
  state.statuses = new Map(statuses);
  state.running = running;
  state.restart.mockClear();
  state.dismiss.mockClear();
  return render(<SidebarModsNotice />);
}

it("says nothing while every machine runs its mods", async () => {
  await using screen = await show([[DEV, { ...rebuilt, restartPending: false }]]);
  expect(screen.container.textContent).toBe("");
});

it("says the mods are coming back while a machine rebuilds them after an update", async () => {
  await using screen = await show([
    [DEV, { ...stock, paused: { mods: [mod], rebuilding: true } }],
    [MAC, { ...stock, paused: { mods: [mod], rebuilding: false } }],
  ]);
  expect(screen.container.textContent).toBe("Bringing your mods back after the update…");
});

it("waits for running threads before the restart, with a button to restart now", async () => {
  await using screen = await show(
    [
      [DEV, rebuilt],
      [MAC, { ...rebuilt, restartPending: false }],
    ],
    2,
  );
  expect(screen.container.textContent).toContain(
    "Your mods switch on once running threads finish.",
  );

  await userEvent.click(screen.getByRole("button", { name: "Restart now" }));
  expect(state.restart).toHaveBeenCalledWith([DEV]);
});

it("names a mod the update broke, until it is dismissed", async () => {
  await using screen = await show([[DEV, { ...stock, needsRepair: [mod] }]]);
  expect(screen.container.textContent).toBe(
    "“Hide the Issues button” no longer fits this T3 Code version. Ask in a thread to repair it.",
  );

  await userEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(state.dismiss).toHaveBeenCalledWith(["hide-issues"]);
});
