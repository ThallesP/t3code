import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { claimedRuntimeOverride } from "@t3tools/shared/runtimeOverride";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import * as ModApprovalRequests from "../../../mods/ModApprovalRequests.ts";
import * as ModService from "../../../mods/ModService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ModsToolkit } from "./tools.ts";

const toMcpFailure = (error: ModService.ModServiceError) =>
  new OrchestratorMcpFailure({
    code:
      error.stage === "validation" || error.stage === "guardrail"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(ModsToolkit, {
  t3_mod_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const modService = yield* ModService.ModService;
      const snapshot = yield* modService.status().pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.message,
            }),
        ),
      );
      const active = snapshot.activeOverride;
      const running = claimedRuntimeOverride();
      // A client-only build is served by the stock server as soon as it is applied.
      const activeIsRunning =
        active !== null &&
        (active.entryPath === undefined
          ? running === null
          : running?.entryPath === active.entryPath);
      const runningModIds = new Set(activeIsRunning ? active.mods.map((mod) => mod.id) : []);
      return {
        currentVersion: snapshot.currentVersion,
        activeBuildId: snapshot.activeOverride?.buildId ?? null,
        activeBaseVersion: snapshot.activeOverride?.baseVersion ?? null,
        fallback:
          snapshot.fallback === null
            ? null
            : {
                reason: snapshot.fallback.reason,
                message: snapshot.fallback.message,
              },
        mods: snapshot.mods.map((mod) => ({
          id: mod.metadata.id,
          title: mod.metadata.title,
          baseVersion: mod.metadata.baseVersion,
          enabled: mod.metadata.enabled,
          running: runningModIds.has(mod.metadata.id),
          verifyTampered: mod.verifyTampered,
        })),
      };
    }),
  ),
  t3_mod_start: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      yield* McpInvocationContext.requireThreadScope(scope, "t3_mod_start");
      const modService = yield* ModService.ModService;
      return yield* modService.startWorkspace(input).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  t3_mod_propose: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_mod_propose");
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const modService = yield* ModService.ModService;
      const approvalRequests = yield* ModApprovalRequests.ModApprovalRequests;
      const random = yield* SecureRandom.SecureRandom;

      const thread = yield* threads.getThreadShell(caller.thread.threadId).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not read the active thread for mod approval.",
            }),
        ),
      );
      const runId = thread?.activeRunId ?? null;
      const run =
        runId === null
          ? undefined
          : (yield* threads
              .getThreadRecords(caller.thread.threadId, ["runs"], { runIds: [runId] })
              .pipe(
                Effect.mapError(
                  () =>
                    new OrchestratorMcpFailure({
                      code: "orchestration_error",
                      message: "Could not load the active run for mod approval.",
                    }),
                ),
              )).runs.find((candidate) => candidate.id === runId);

      if (run === undefined || run.rootNodeId === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "t3_mod_propose requires an active thread run to show its approval card.",
        });
      }

      const preview = yield* modService.prepareCandidate(input).pipe(Effect.mapError(toMcpFailure));

      const requestId = yield* random.uuidV7();
      const { turnItemId } = yield* approvalRequests
        .showCard({
          requestId,
          threadId: caller.thread.threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          preview,
        })
        .pipe(
          // Without its card nobody can apply or decline this build.
          Effect.tapError(() => modService.discardCandidate({ buildId: preview.buildId })),
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.message,
              }),
          ),
        );

      return {
        status: "pending_approval" as const,
        turnItemId,
        buildId: preview.buildId,
        artifactSha256: preview.artifactSha256,
        stockFailed: preview.verification.stockFailed,
        restartRequired: preview.restartRequired ?? true,
        warnings: [...preview.warnings],
      };
    }),
  ),
  t3_mod_rollback: McpToolAccess.writesEnvironment(() =>
    Effect.gen(function* () {
      const modService = yield* ModService.ModService;
      const { restartRequired } = yield* modService.disableAll().pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.message,
            }),
        ),
      );
      return { disabled: true, restartRequired };
    }),
  ),
  t3_mod_upgrade_check: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const modService = yield* ModService.ModService;
      const results = yield* modService.checkUpgrade().pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: error.message,
            }),
        ),
      );
      return {
        results: results.map((entry) => ({
          id: entry.id,
          title: entry.title,
          previousBaseVersion: entry.previousBaseVersion,
          status: entry.status,
          detail: entry.detail,
          intent: entry.intent,
        })),
      };
    }),
  ),
});
