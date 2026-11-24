import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ModApprovalRequests from "../../../mods/ModApprovalRequests.ts";
import * as ModService from "../../../mods/ModService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ModService.ModService,
    ModApprovalRequests.ModApprovalRequests,
    ThreadManagementService.ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
};

const ModStatusTool = Tool.make("t3_mod_status", {
  ...shared,
  description:
    "List the user's mods (their own changes to T3 Code itself) and whether an update paused them.",
  success: Schema.Struct({
    currentVersion: Schema.String,
    activeBuildId: Schema.NullOr(Schema.String),
    activeBaseVersion: Schema.NullOr(Schema.String),
    fallback: Schema.NullOr(
      Schema.Struct({
        reason: Schema.String,
        message: Schema.String,
      }),
    ),
    mods: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        baseVersion: Schema.String,
        enabled: Schema.Boolean,
        running: Schema.Boolean.annotate({ description: "Part of the T3 Code now running." }),
        verifyTampered: Schema.Boolean,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ModStartTool = Tool.make("t3_mod_start", {
  ...shared,
  description:
    "Start here when the user asks to change T3 Code itself (its UI or behavior), not their project. Returns workspaceDir: a checkout of the source this T3 Code runs, dependencies installed, the mod's saved change applied. Edit files there, then call t3_mod_propose. Never clone T3 Code or open a pull request for this. Can take minutes.",
  parameters: Schema.Struct({
    id: Schema.String.annotate({
      description: "Lowercase slug, e.g. hide-sidebar-issues. Reuse it to edit that mod.",
    }),
    reset: Schema.optionalKey(
      Schema.Boolean.annotate({
        description: "Discard the workspace's edits and restart from the saved mod.",
      }),
    ),
  }),
  success: Schema.Struct({
    workspaceDir: Schema.String,
    created: Schema.Boolean,
    baseOutdated: Schema.Boolean.annotate({
      description: "T3 Code updated since this workspace was made. Pass reset to rebase onto it.",
    }),
    savedPatch: Schema.Literals(["none", "applied", "conflicted", "kept"]).annotate({
      description:
        "conflicted: the saved change no longer applies cleanly; resolve the conflict markers.",
    }),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ModProposeTool = Tool.make("t3_mod_propose", {
  ...shared,
  description:
    "Build a mod's workspace into a candidate T3 Code and show the user a card with Preview, Apply and Decline. Runs the check without the change (should fail) and with it (must pass). Takes minutes. Then end your turn: the user decides on the card. On failure, fix the workspace and call again.",
  parameters: Schema.Struct({
    id: Schema.String.annotate({ description: "The id given to t3_mod_start." }),
    title: Schema.String.annotate({ description: "Short human-readable title." }),
    intent: Schema.String.annotate({
      description: "3-8 plain lines for the user: what changes and what stays the same.",
    }),
    verifySource: Schema.String.annotate({
      description:
        "TypeScript that checks the behavior, not the diff text. Do not save it in the workspace.",
    }),
    verifyPath: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "New repo-relative file to save the check as while it runs, not a file to check. *.test.ts(x) runs in that package's test runner. Omit for a Node script run from the repo root that exits non-zero on failure.",
      }),
    ),
  }),
  success: Schema.Struct({
    status: Schema.Literal("pending_approval"),
    turnItemId: Schema.String,
    buildId: Schema.String,
    artifactSha256: Schema.String,
    stockFailed: Schema.Boolean,
    warnings: Schema.Array(Schema.String),
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const ModRollbackTool = Tool.make("t3_mod_rollback", {
  ...shared,
  description:
    "Turn off every mod so the next restart runs stock T3 Code. They stay saved; t3_mod_start then t3_mod_propose turns one back on.",
  success: Schema.Struct({
    disabled: Schema.Boolean,
    restartRequired: Schema.Boolean,
  }),
}).annotate(Tool.Destructive, true);

const ModUpgradeCheckTool = Tool.make("t3_mod_upgrade_check", {
  ...shared,
  description:
    "After a T3 Code update, test whether each mod still applies and passes its check. Repair one with t3_mod_start, then t3_mod_propose.",
  success: Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        previousBaseVersion: Schema.String,
        status: Schema.Literals([
          "already_fixed_upstream",
          "ready",
          "needs_repair",
          "verify_tampered",
        ]),
        detail: Schema.String,
        intent: Schema.String,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const ModsToolkit = Toolkit.make(
  ModStatusTool,
  ModStartTool,
  ModProposeTool,
  ModRollbackTool,
  ModUpgradeCheckTool,
);
