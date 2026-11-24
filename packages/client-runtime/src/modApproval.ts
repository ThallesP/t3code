import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

export type ModApprovalRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "mod_approval_request" }
>;

export type ModApprovalDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "applied" | "not-applied";
      readonly label: string;
    };

export function modApprovalDisplay(
  item: Pick<ModApprovalRequestItem, "modApprovalStatus">,
  visibility: "local" | "inherited" | "synthetic",
  resolve: MFunctionType = mFallback,
): ModApprovalDisplay {
  switch (item.modApprovalStatus) {
    case "pending":
      return visibility === "local"
        ? { kind: "pending" }
        : { kind: "pending-elsewhere", label: resolve(msg("Waiting in the original thread")) };
    case "applied":
      return {
        kind: "answered",
        outcome: "applied",
        label: resolve(msg("Applied (restart to activate)")),
      };
    case "declined":
      return { kind: "answered", outcome: "not-applied", label: resolve(msg("Declined")) };
    case "cancelled":
      return {
        kind: "answered",
        outcome: "not-applied",
        label: resolve(msg("Closed without applying")),
      };
  }
}

export function shortArtifactDigest(sha256: string): string {
  return sha256.slice(0, 12);
}

export function modApprovalFailureMessage(
  failure: unknown,
  resolve: MFunctionType = mFallback,
): string {
  if (failure instanceof Error && failure.message.trim().length > 0) {
    return failure.message;
  }
  if (
    typeof failure === "object" &&
    failure !== null &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return resolve(msg("Could not process this customization decision."));
}
