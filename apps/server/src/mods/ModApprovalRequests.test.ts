import { type ModApprovalPreview, NodeId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ModApprovalRequests from "./ModApprovalRequests.ts";
import * as ModService from "./ModService.ts";

const threadId = ThreadId.make("thread:mod-approval");
const runId = RunId.make("run:mod-approval");
const nodeId = NodeId.make("node:mod-approval");

const samplePreview: ModApprovalPreview = {
  modId: "keep-scheduled-settled",
  title: "Keep scheduled threads settled",
  intent: "Keep scheduled task threads settled after completion.",
  baseVersion: "0.1.11",
  buildId: "keep-scheduled-settled-abc123",
  artifactSha256: "a".repeat(64),
  verifySha256: "b".repeat(64),
  files: ["apps/server/src/scheduledTasks/ScheduledTaskService.ts"],
  diffPreview: "diff --git a/a.ts b/a.ts\n-false\n+true\n",
  diffTruncated: false,
  warnings: [],
  verification: {
    stockFailed: true,
    candidatePassed: true,
    summary: "Failed on stock T3 Code and passed on the patched candidate.",
  },
};

function makeHarness() {
  return Effect.gen(function* () {
    const storedStatusRef = yield* Ref.make<"pending" | "applied" | "declined" | "cancelled">(
      "pending",
    );
    const activatedRef = yield* Ref.make<ReadonlyArray<{ buildId: string; sha: string }>>([]);
    const discardedRef = yield* Ref.make<ReadonlyArray<string>>([]);

    const threadsLayer = Layer.succeed(ThreadManagementService.ThreadManagementService, {
      dispatch: (command: {
        readonly type: string;
        readonly modApprovalStatus?: "pending" | "applied" | "declined" | "cancelled";
      }) =>
        Effect.gen(function* () {
          if (command.type === "mod_approval_request.record" && command.modApprovalStatus) {
            yield* Ref.set(storedStatusRef, command.modApprovalStatus);
          }
          return {} as never;
        }),
      getThreadRecords: () =>
        Effect.gen(function* () {
          const status = yield* Ref.get(storedStatusRef);
          return {
            turnItems: [
              {
                id: TurnItemId.make("turn-item:mod-approval:req-1"),
                threadId,
                runId,
                nodeId,
                type: "mod_approval_request",
                preview: samplePreview,
                modApprovalStatus: status,
              },
            ],
          } as never;
        }),
    } as unknown as ThreadManagementService.ThreadManagementService["Service"]);

    const modServiceLayer = Layer.mock(ModService.ModService)({
      previewCandidate: () => Effect.succeed({ previewUrl: "http://127.0.0.1:41234" }),
      activateBuild: ({ buildId, expectedArtifactSha256 }) =>
        Ref.update(activatedRef, (items) => [
          ...items,
          { buildId, sha: expectedArtifactSha256 },
        ]).pipe(Effect.as({ restartRequired: true as const })),
      discardCandidate: ({ buildId }) =>
        Ref.update(discardedRef, (items) => [...items, buildId]),
    });

    const layer = ModApprovalRequests.layer.pipe(
      Layer.provide(Layer.merge(threadsLayer, modServiceLayer)),
    );

    return { layer, storedStatusRef, activatedRef, discardedRef };
  });
}

describe("ModApprovalRequests", () => {
  it.effect(
    "supports preview, rejects digest mismatch, and applies with exact approved digest",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();

        yield* Effect.gen(function* () {
          const service = yield* ModApprovalRequests.ModApprovalRequests;
          const { turnItemId } = yield* service.showCard({
            requestId: "req-1",
            threadId,
            runId,
            nodeId,
            preview: samplePreview,
          });

          // Preview starts isolated sandbox and leaves card pending.
          const previewRes = yield* service.answer({
            threadId,
            turnItemId,
            answer: "preview",
          });
          assert.equal(previewRes.status, "pending");
          assert.equal(previewRes.previewUrl, "http://127.0.0.1:41234");
          assert.equal(yield* Ref.get(harness.storedStatusRef), "pending");

          // Applying without matching artifactSha256 is refused.
          const mismatch = yield* service
            .answer({
              threadId,
              turnItemId,
              answer: "apply",
              expectedArtifactSha256: "f".repeat(64),
            })
            .pipe(Effect.flip);
          assert.equal(mismatch.reason, "artifact_mismatch");

          // Applying with exact digest activates build and closes card as applied.
          const applied = yield* service.answer({
            threadId,
            turnItemId,
            answer: "apply",
            expectedArtifactSha256: samplePreview.artifactSha256,
          });
          assert.equal(applied.status, "applied");
          assert.isTrue(applied.restartRequired);
          assert.equal(yield* Ref.get(harness.storedStatusRef), "applied");
          assert.equal((yield* Ref.get(harness.activatedRef)).length, 1);

          // Answering again after decision is refused.
          const second = yield* service
            .answer({ threadId, turnItemId, answer: "decline" })
            .pipe(Effect.flip);
          assert.equal(second.reason, "already_answered");
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("deletes the built candidate when the user declines it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const service = yield* ModApprovalRequests.ModApprovalRequests;
        const { turnItemId } = yield* service.showCard({
          requestId: "req-1",
          threadId,
          runId,
          nodeId,
          preview: samplePreview,
        });

        const declined = yield* service.answer({ threadId, turnItemId, answer: "decline" });

        assert.equal(declined.status, "declined");
        assert.deepEqual(yield* Ref.get(harness.discardedRef), [samplePreview.buildId]);
        assert.isEmpty(yield* Ref.get(harness.activatedRef));
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
