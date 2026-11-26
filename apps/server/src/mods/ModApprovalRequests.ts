import {
  CommandId,
  type ModApprovalAnswerInput,
  type ModApprovalAnswerResult,
  type ModApprovalPreview,
  ModApprovalRequestError,
  type ModApprovalRequestStatus,
  type NodeId,
  type RunId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as ModService from "./ModService.ts";

const CARD_PREFIX = "turn-item:mod-approval:";

export interface ModApprovalCardInput {
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly preview: ModApprovalPreview;
}

export class ModApprovalRequests extends Context.Service<
  ModApprovalRequests,
  {
    readonly showCard: (
      card: ModApprovalCardInput,
    ) => Effect.Effect<{ readonly turnItemId: TurnItemId }, ModApprovalRequestError>;
    readonly answer: (
      input: ModApprovalAnswerInput,
    ) => Effect.Effect<ModApprovalAnswerResult, ModApprovalRequestError>;
  }
>()("t3/mods/ModApprovalRequests") {}

const make = Effect.gen(function* () {
  const threads = yield* Threads.ThreadManagementService;
  const modService = yield* ModService.ModService;
  const answerLock = yield* Semaphore.make(1);

  const record = Effect.fn("ModApprovalRequests.record")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly nodeId: NodeId;
    readonly turnItemId: TurnItemId;
    readonly preview: ModApprovalPreview;
    readonly modApprovalStatus: ModApprovalRequestStatus;
    readonly suffix: string;
  }) {
    yield* threads
      .dispatch({
        type: "mod_approval_request.record",
        commandId: CommandId.make(`${input.turnItemId}:${input.suffix}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: input.nodeId,
        turnItemId: input.turnItemId,
        preview: input.preview,
        modApprovalStatus: input.modApprovalStatus,
      })
      .pipe(
        Effect.mapError((cause) => new ModApprovalRequestError({ reason: "record_failed", cause })),
      );
  });

  const showCard: ModApprovalRequests["Service"]["showCard"] = Effect.fn(
    "ModApprovalRequests.showCard",
  )(function* (card) {
    const turnItemId = TurnItemId.make(`${CARD_PREFIX}${card.requestId}`);
    // Proposing a mod again deletes the build of its earlier proposal, so that card can no
    // longer be applied and must not stay open next to this one.
    const earlier = yield* threads
      .getThreadRecords(card.threadId, ["turnItems"], {
        turnItemTypes: ["mod_approval_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((cause) => new ModApprovalRequestError({ reason: "load_failed", cause })),
      );
    for (const item of earlier.turnItems) {
      if (
        item.type !== "mod_approval_request" ||
        item.modApprovalStatus !== "pending" ||
        item.preview.modId !== card.preview.modId ||
        item.runId === null ||
        item.nodeId === null
      ) {
        continue;
      }
      yield* record({
        threadId: item.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        turnItemId: item.id,
        preview: item.preview,
        modApprovalStatus: "cancelled",
        suffix: "replace",
      });
    }
    yield* record({
      threadId: card.threadId,
      runId: card.runId,
      nodeId: card.nodeId,
      turnItemId,
      preview: card.preview,
      modApprovalStatus: "pending",
      suffix: "show",
    });
    return { turnItemId };
  });

  const answer: ModApprovalRequests["Service"]["answer"] = Effect.fn("ModApprovalRequests.answer")(
    function* (input) {
      return yield* answerLock.withPermits(1)(
        Effect.gen(function* () {
          const records = yield* threads
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["mod_approval_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError(
                (cause) => new ModApprovalRequestError({ reason: "load_failed", cause }),
              ),
            );

          const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
          if (
            item?.type !== "mod_approval_request" ||
            item.runId === null ||
            item.nodeId === null
          ) {
            return yield* new ModApprovalRequestError({ reason: "not_found" });
          }
          if (item.modApprovalStatus !== "pending") {
            return yield* new ModApprovalRequestError({ reason: "already_answered" });
          }

          if (input.answer === "decline") {
            yield* modService
              .discardCandidate({ buildId: item.preview.buildId })
              .pipe(Effect.ignore);
            yield* record({
              threadId: item.threadId,
              runId: item.runId,
              nodeId: item.nodeId,
              turnItemId: item.id,
              preview: item.preview,
              modApprovalStatus: "declined",
              suffix: "decline",
            });
            return { status: "declined" as const };
          }

          if (input.answer === "preview") {
            const { previewUrl } = yield* modService
              .previewCandidate({ buildId: item.preview.buildId })
              .pipe(
                Effect.mapError(
                  (cause) => new ModApprovalRequestError({ reason: "preview_failed", cause }),
                ),
              );
            return { status: "pending" as const, previewUrl };
          }

          if (
            input.expectedArtifactSha256 === undefined ||
            input.expectedArtifactSha256 !== item.preview.artifactSha256
          ) {
            return yield* new ModApprovalRequestError({ reason: "artifact_mismatch" });
          }

          const activated = yield* modService
            .activateBuild({
              buildId: item.preview.buildId,
              expectedArtifactSha256: input.expectedArtifactSha256,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new ModApprovalRequestError({
                    reason: cause.activation ?? "activate_failed",
                    cause,
                  }),
              ),
            );

          yield* record({
            threadId: item.threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            turnItemId: item.id,
            preview: item.preview,
            modApprovalStatus: "applied",
            suffix: "apply",
          });

          // A restart interrupts this machine's threads, so it waits for the user to ask for it.
          return {
            status: "applied" as const,
            activation: activated.restartRequired
              ? ("restart_required" as const)
              : ("live" as const),
          };
        }),
      );
    },
  );

  return ModApprovalRequests.of({ showCard, answer });
});

export const layer = Layer.effect(ModApprovalRequests, make);
