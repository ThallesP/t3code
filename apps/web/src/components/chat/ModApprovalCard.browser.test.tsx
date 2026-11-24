import {
  EnvironmentId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModApprovalPreview,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import type { ModApprovalRequestItem } from "@t3tools/client-runtime/mod-approval";
import { render } from "../../../test/render";
import { ModApprovalCard } from "./ModApprovalCard";

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

it("renders the pending customization approval card with intent, digest, and expandable diff", async () => {
  await using screen = await render(
    <ModApprovalCard
      environmentId={EnvironmentId.make("environment:local")}
      threadRef={null}
      item={makeItem()}
      visibility="local"
    />,
  );

  await expect.element(screen.getByText("Keep scheduled threads settled")).toBeVisible();
  await expect.element(screen.getByText("v0.1.11")).toBeVisible();
  await expect.element(screen.getByText("a1b2c3d4e5f6")).toBeVisible();
  await expect
    .element(screen.getByText("Failed on stock T3 Code and passed on the patched candidate."))
    .toBeVisible();

  await userEvent.click(screen.getByRole("button", { name: /View the change/i }));
  await expect.element(screen.getByText(/\+keepSettled = true/)).toBeVisible();
});

it("collapses an applied customization into a compact work log row", async () => {
  await using screen = await render(
    <ModApprovalCard
      environmentId={EnvironmentId.make("environment:local")}
      threadRef={null}
      item={makeItem({ status: "completed", modApprovalStatus: "applied" })}
      visibility="local"
    />,
  );

  await expect.element(screen.getByText(/Keep scheduled threads settled · Applied/)).toBeVisible();
});
