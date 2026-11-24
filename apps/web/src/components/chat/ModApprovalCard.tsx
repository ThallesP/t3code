import { T, useGT, useMessages } from "gt-react";
import { pipe } from "effect/Function";
import {
  modApprovalDisplay,
  modApprovalFailureMessage,
  shortArtifactDigest,
  type ModApprovalRequestItem,
} from "@t3tools/client-runtime/mod-approval";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ModApprovalPreview,
  OrchestrationV2ProjectedTurnItem,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronDownIcon,
  LockIcon,
  MinusIcon,
  ShieldCheckIcon,
  WrenchIcon,
} from "lucide-react";
import { useRef, useState } from "react";

import { canOpenLinksInApp } from "../../browser/browserLinkTarget";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { readLocalApi } from "../../localApi";
import { previewEnvironment } from "../../state/preview";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { WorkLogRow } from "./WorkLog";

export function ModApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: ModApprovalRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const m = useMessages();
  const { item } = props;
  const display = modApprovalDisplay(item, props.visibility, m);
  if (display.kind !== "pending") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "applied"
          ? CheckIcon
          : MinusIcon;
    return (
      <Collapsible data-v2-item-type={item.type}>
        <CollapsibleTrigger
          render={
            <WorkLogRow
              icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
              label={
                <>
                  {item.preview.title} · {display.label}
                </>
              }
              trailing={<ChevronDownIcon className="size-3.5 text-icon-muted" aria-hidden />}
            />
          }
        />
        <CollapsiblePanel>
          <div className="pt-2 pb-1 pl-5">
            <ModPreviewDetails preview={item.preview} />
          </div>
        </CollapsiblePanel>
      </Collapsible>
    );
  }
  return (
    <PendingModApprovalCard
      environmentId={props.environmentId}
      threadRef={props.threadRef}
      item={item}
    />
  );
}

function PendingModApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: ModApprovalRequestItem;
}) {
  const gt = useGT();
  const m = useMessages();
  const { item } = props;
  const answer = useAtomCommand(serverEnvironment.answerModApproval, {
    label: "answer mod approval",
    reportFailure: false,
  });
  const canAnswer = useAtomValue(
    serverEnvironment.answerModApproval.permissionAtom(props.environmentId),
  );
  const [submitting, setSubmitting] = useState<"preview" | "apply" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [previewOpened, setPreviewOpened] = useState(false);
  // Two clicks can land before a render.
  const inFlight = useRef(false);

  // The preview listens on the environment's loopback, which only its own browser panel reaches
  // from a remote client. The link signs in once, so it is opened right away and never shown.
  const openCandidate = async (url: string) => {
    if (props.threadRef !== null && canOpenLinksInApp(props.threadRef)) {
      const opened = await openUrlInPreview({ threadRef: props.threadRef, url, openPreview });
      if (opened._tag === "Success") return true;
    }
    const api = readLocalApi();
    if (!api) return false;
    return api.shell.openExternal(url).then(
      () => true,
      () => false,
    );
  };

  const send = async (reply: "preview" | "apply" | "decline") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(reply);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        threadId: item.threadId,
        turnItemId: item.id,
        answer: reply,
        ...(reply === "apply" ? { expectedArtifactSha256: item.preview.artifactSha256 } : {}),
      },
    });
    if (result._tag === "Success" && result.value.previewUrl !== undefined) {
      const opened = await openCandidate(result.value.previewUrl);
      setPreviewOpened(opened);
      if (!opened) setError(gt("The preview started, but this app could not open it."));
    }
    inFlight.current = false;
    setSubmitting(null);
    if (result._tag === "Success") return;
    if (!isAtomCommandInterrupted(result)) {
      pipe(
        squashAtomCommandFailure(result),
        (failure) => modApprovalFailureMessage(failure, m),
        setError,
      );
    }
  };

  const disabled = submitting !== null || !canAnswer;
  const verifiedRedGreen =
    item.preview.verification.stockFailed && item.preview.verification.candidatePassed;

  return (
    <section
      data-v2-item-type={item.type}
      aria-label={gt("Apply T3 Code customization: {title}", { title: item.preview.title })}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <WrenchIcon className="size-3.5 shrink-0 text-icon-muted" aria-hidden />
            <span>{item.preview.title}</span>
          </h3>
          <div className="flex items-center gap-1.5">
            <Badge variant="outline">v{item.preview.baseVersion}</Badge>
            <Badge variant="secondary">{shortArtifactDigest(item.preview.artifactSha256)}</Badge>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          <T>A change to T3 Code itself, built and ready. Nothing changes until you press Apply.</T>
        </p>
      </div>

      <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
        <p className="whitespace-pre-wrap text-xs text-foreground">{item.preview.intent}</p>
      </div>

      <div className="flex items-start gap-2 text-xs">
        {verifiedRedGreen ? (
          <ShieldCheckIcon className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
        ) : (
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-foreground">{item.preview.verification.summary}</span>
          <span className="text-muted-foreground">
            <T>The check is saved with the mod, to re-test it after T3 Code updates.</T>
          </span>
        </div>
      </div>

      {item.preview.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/10 p-2.5 text-xs text-foreground">
          {item.preview.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      <ModPreviewDetails preview={item.preview} />

      {previewOpened ? (
        <p className="text-xs text-muted-foreground">
          <T>
            The preview is open in the browser. It runs this build on empty scratch data, so your
            threads are not there.
          </T>
        </p>
      ) : null}

      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : !canAnswer ? (
        <p className="text-xs text-muted-foreground">
          <T>
            Only someone who can operate agents on this machine can preview or apply customizations.
          </T>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void send("decline")}>
          {submitting === "decline" ? gt("Declining...") : gt("Decline")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => void send("preview")}
        >
          {submitting === "preview" ? gt("Starting preview...") : gt("Preview")}
        </Button>
        <Button variant="default" size="sm" disabled={disabled} onClick={() => void send("apply")}>
          {submitting === "apply" ? gt("Applying...") : gt("Apply")}
        </Button>
      </div>
    </section>
  );
}

function ModPreviewDetails(props: { readonly preview: ModApprovalPreview }) {
  const gt = useGT();
  const { preview } = props;
  const fileCount = preview.files.length;
  return (
    <Collapsible>
      <CollapsibleTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 rounded-md border border-border/50 px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <span>
              {gt("View the change ({count, plural, one {{count} file} other {{count} files}})", {
                count: fileCount,
              })}
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
          </button>
        }
      />
      <CollapsiblePanel>
        <div className="mt-2 flex flex-col gap-2">
          {preview.files.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {preview.files.map((file) => (
                <Badge key={file} variant="outline">
                  {file}
                </Badge>
              ))}
            </div>
          ) : null}
          <pre className="max-h-72 overflow-auto rounded-lg border border-border/50 bg-muted/30 p-3 font-mono text-2xs leading-relaxed text-foreground">
            {preview.diffPreview}
          </pre>
          {preview.diffTruncated ? (
            <p className="text-2xs text-muted-foreground">
              <T>The change is longer than shown here. Ask the agent for the full diff.</T>
            </p>
          ) : null}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
