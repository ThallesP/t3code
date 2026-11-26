import {
  EnvironmentId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModApprovalPreview,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import type { ModApprovalRequestItem } from "@t3tools/client-runtime/mod-approval";
import { render } from "../../../test/render";

const DEV = EnvironmentId.make("environment:dev");
const MAC = EnvironmentId.make("environment:mac");
const OLD = EnvironmentId.make("environment:old");

const state = vi.hoisted(() => ({
  machines: [] as ReadonlyArray<{ environmentId: string; label: string; serverConfig: unknown }>,
  rollOut: vi.fn(),
  setIncluded: vi.fn(),
  answer: vi.fn(),
  // This page is served by dev, so it is dev's interface it shows.
  local: "environment:dev",
}));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.answer }));
vi.mock("../../state/primaryEnvironment", async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await importOriginal<typeof import("../../state/primaryEnvironment")>()),
    localEnvironmentIdAtom: Atom.make(() => state.local),
  };
});
vi.mock("../../state/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/server")>();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...original,
    serverEnvironment: {
      ...original.serverEnvironment,
      answerModApproval: { permissionAtom: () => allowed },
    },
  };
});

vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironments: () => ({ environments: state.machines }),
}));
vi.mock("../../state/mods", async () => {
  const { Atom } = await import("effect/reactivity");
  const running = (restartPending: boolean) => ({
    serverVersion: "0.1.11",
    build: {
      buildId: "keep-scheduled-settled-abc123",
      baseVersion: "0.1.11",
      artifactSha256: "a",
      restartRequired: true,
      clientFiles: [],
      mods: [],
    },
    restartPending,
    canRestart: true,
  });
  return {
    modStatusesAtom: Atom.make(
      new Map<string, unknown>([
        ["environment:dev", running(true)],
        ["environment:mac", { ...running(false), build: null }],
        ["environment:old", { ...running(false), build: null, serverVersion: "0.1.10" }],
      ]),
    ),
    excludedModMachinesAtom: Atom.make<ReadonlyArray<string>>([]),
    modMachineStepsAtom: Atom.make(new Map<string, string>()),
    modMachineFailuresAtom: Atom.make(new Map<string, string>()),
    rollOutMod: state.rollOut,
    setModMachineIncluded: state.setIncluded,
  };
});

import { ModApprovalCard } from "./ModApprovalCard";

const takesBuilds = { environment: { capabilities: { modBuildTransfer: true } }, settings: {} };
const twoMachines = [
  { environmentId: DEV, label: "dev", serverConfig: takesBuilds },
  { environmentId: MAC, label: "This Mac", serverConfig: takesBuilds },
];

const NOW = DateTime.makeUnsafe("2026-11-24T18:00:00.000Z");

const preview: ModApprovalPreview = {
  modId: "keep-scheduled-settled",
  title: "Keep scheduled threads settled",
  intent: "Keep scheduled task threads settled after each scheduled run completes.",
  baseVersion: "0.1.11",
  buildId: "keep-scheduled-settled-abc123",
  artifactSha256: "a1b2c3d4e5f6".padEnd(64, "0"),
  verifySha256: "f6e5d4c3b2a1".padEnd(64, "0"),
  files: ["apps/server/src/scheduledTasks/ScheduledTaskService.ts"],
  diffPreview: "diff --git a/a.ts b/a.ts\n-keepSettled = false\n+keepSettled = true",
  diffTruncated: false,
  warnings: [],
  verification: {
    stockFailed: true,
    candidatePassed: true,
    summary: "Failed on stock T3 Code and passed on the patched candidate.",
  },
};

function makeItem(overrides: Partial<ModApprovalRequestItem> = {}): ModApprovalRequestItem {
  return {
    id: TurnItemId.make("turn-item:mod-approval:req-1"),
    threadId: ThreadId.make("thread:1"),
    runId: RunId.make("run:1"),
    nodeId: NodeId.make("node:1"),
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    title: preview.title,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    type: "mod_approval_request",
    preview,
    modApprovalStatus: "pending",
    ...overrides,
  };
}

it("shows a pending mod as a plain card: what it does and what applying costs", async () => {
  state.machines = twoMachines;
  await using screen = await render(
    <ModApprovalCard environmentId={DEV} threadRef={null} item={makeItem()} visibility="local" />,
  );

  await expect.element(screen.getByText("Keep scheduled threads settled")).toBeVisible();
  await expect.element(screen.getByText(preview.intent)).toBeVisible();
  await expect.element(screen.getByText(/Applying it restarts T3 Code/)).toBeVisible();
  // A check that proved the change is not worth a line.
  expect(screen.getByText(preview.verification.summary).elements()).toHaveLength(0);
  expect(screen.getByText("v0.1.11").elements()).toHaveLength(0);

  // The diff waits on the answered card; the pending one is about the decision.
  expect(screen.getByRole("button", { name: /View the change/i }).elements()).toHaveLength(0);
});

it("asks once where the mod goes, then applies, copies and restarts without another click", async () => {
  state.machines = [
    ...twoMachines,
    { environmentId: OLD, label: "old box", serverConfig: takesBuilds },
  ];
  state.answer
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ status: "applied", activation: "restart_required" }));
  state.rollOut.mockReset().mockResolvedValue(undefined);
  await using screen = await render(
    <ModApprovalCard environmentId={DEV} threadRef={null} item={makeItem()} visibility="local" />,
  );

  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
  // Every machine that can take it is in by default; one on another version cannot.
  await expect.element(screen.getByRole("heading", { name: "Apply to 2 machines?" })).toBeVisible();
  await expect.element(screen.getByRole("checkbox", { name: "This Mac" })).toBeChecked();
  await expect.element(screen.getByRole("checkbox", { name: "dev" })).toBeDisabled();
  await expect.element(screen.getByRole("checkbox", { name: "old box" })).toBeDisabled();
  await expect.element(screen.getByText("Runs 0.1.10, update it first")).toBeVisible();
  expect(state.answer).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "Apply and restart" }));
  await expect
    .poll(() => state.rollOut.mock.calls)
    .toEqual([[{ source: DEV, targets: [DEV, MAC] }]]);
  expect(state.answer).toHaveBeenCalledOnce();
});

it("lets a machine be left out, and says when the check proved nothing", async () => {
  state.machines = twoMachines;
  state.setIncluded.mockReset();
  await using screen = await render(
    <ModApprovalCard
      environmentId={DEV}
      threadRef={null}
      item={makeItem({
        preview: {
          ...preview,
          restartRequired: false,
          verification: { stockFailed: false, candidatePassed: true, summary: "Passed both ways." },
        },
      })}
      visibility="local"
    />,
  );

  await expect.element(screen.getByText("Passed both ways.")).toBeVisible();
  expect(screen.getByText(/restarts T3 Code/).elements()).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "Apply" }));
  await expect
    .element(screen.getByRole("button", { name: "Apply", exact: true }).last())
    .toBeVisible();
  await expect.element(screen.getByRole("columnheader", { name: "Status" })).toBeVisible();
  await expect.element(screen.getByRole("cell", { name: "No restart" }).first()).toBeVisible();
  await userEvent.click(screen.getByRole("checkbox", { name: "This Mac" }));
  expect(state.setIncluded).toHaveBeenCalledWith(MAC, false);
});

it("shows where an applied mod stands on each machine, with one button to finish it there", async () => {
  state.machines = twoMachines;
  state.rollOut.mockReset().mockResolvedValue(undefined);
  await using screen = await render(
    <ModApprovalCard
      environmentId={DEV}
      threadRef={null}
      item={makeItem({ status: "completed", modApprovalStatus: "applied" })}
      visibility="local"
    />,
  );

  await expect.element(screen.getByText(/Keep scheduled threads settled · Applied/)).toBeVisible();
  await expect.element(screen.getByText("Not restarted yet")).toBeVisible();
  await expect.element(screen.getByText("Not applied")).toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: "Apply and restart" }));
  expect(state.rollOut).toHaveBeenLastCalledWith({ source: DEV, targets: [MAC] });

  await userEvent.click(screen.getByRole("button", { name: "Restart", exact: true }));
  expect(state.rollOut).toHaveBeenLastCalledWith({ source: DEV, targets: [DEV] });
});
