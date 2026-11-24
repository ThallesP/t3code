import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/** Deterministic red-on-stock / green-on-candidate check results recorded before approval. */
export const ModApprovalVerification = Schema.Struct({
  stockFailed: Schema.Boolean,
  candidatePassed: Schema.Boolean,
  summary: Schema.String,
});
export type ModApprovalVerification = typeof ModApprovalVerification.Type;

/** Exact summary, diff preview, and artifact digest shown in the in-chat approval card. */
export const ModApprovalPreview = Schema.Struct({
  modId: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  intent: Schema.String,
  baseVersion: TrimmedNonEmptyString,
  buildId: TrimmedNonEmptyString,
  artifactSha256: TrimmedNonEmptyString,
  verifySha256: TrimmedNonEmptyString,
  files: Schema.Array(Schema.String),
  diffPreview: Schema.String,
  diffTruncated: Schema.Boolean,
  warnings: Schema.Array(Schema.String),
  verification: ModApprovalVerification,
});
export type ModApprovalPreview = typeof ModApprovalPreview.Type;

export const ModApprovalRequestStatus = Schema.Literals([
  "pending",
  "applied",
  "declined",
  "cancelled",
]);
export type ModApprovalRequestStatus = typeof ModApprovalRequestStatus.Type;

export const ModApprovalAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Literals(["preview", "apply", "decline"]),
  /** Required on apply so activation matches the exact built artifact shown in the card. */
  expectedArtifactSha256: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ModApprovalAnswerInput = typeof ModApprovalAnswerInput.Type;

export const ModApprovalAnswerResult = Schema.Struct({
  status: ModApprovalRequestStatus,
  /** Signs the opener in to the preview once, so it goes to the asking client and is never stored. */
  previewUrl: Schema.optionalKey(Schema.String),
  restartRequired: Schema.optionalKey(Schema.Boolean),
});
export type ModApprovalAnswerResult = typeof ModApprovalAnswerResult.Type;

const MOD_APPROVAL_FAILURE_MESSAGES = {
  load_failed: "Could not load this customization request.",
  not_found: "This customization request no longer exists.",
  already_answered: "This customization request was already decided.",
  artifact_mismatch:
    "The built artifact changed after this card was created. Ask the agent to re-propose it.",
  build_missing: "The candidate build is no longer on disk. Ask the agent to rebuild it.",
  stale_build: "Your mods changed after this build was made. Ask the agent to propose it again.",
  dev_server:
    "This is a development server running T3 Code's source directly, so Apply has nothing to swap. Preview works here; Apply works on an installed T3 Code, in the app or the browser.",
  preview_failed: "Could not start an isolated preview for this customization.",
  activate_failed: "Could not activate this customization build.",
  record_failed: "Could not record your decision.",
} as const;

export class ModApprovalRequestError extends Schema.TaggedError<ModApprovalRequestError>()(
  "ModApprovalRequestError",
  {
    reason: Schema.Literals(
      Object.keys(MOD_APPROVAL_FAILURE_MESSAGES) as Array<
        keyof typeof MOD_APPROVAL_FAILURE_MESSAGES
      >,
    ),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return MOD_APPROVAL_FAILURE_MESSAGES[this.reason];
  }
}
