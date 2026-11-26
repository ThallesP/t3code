import { T, useGT, useMessages } from "gt-react";
import { pipe } from "effect/Function";
import {
  modApprovalDisplay,
  modApprovalFailureMessage,
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
import { CheckIcon, ChevronDownIcon, LockIcon, MinusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { canOpenLinksInApp } from "../../browser/browserLinkTarget";
import { openUrlInPreview } from "../../browser/openFileInPreview";
import { readLocalApi } from "../../localApi";
import { previewEnvironment } from "../../state/preview";
import { useEnvironments } from "../../state/environments";
import {
  excludedModMachinesAtom,
  modMachineFailuresAtom,
  modMachineStepsAtom,
  modStatusesAtom,
  rollOutMod,
  setModMachineIncluded,
} from "../../state/mods";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { ModApplyDialog, type ModMachine, takesMod } from "./ModApplyDialog";
import { WorkLogRow } from "./WorkLog";

/** The machines a mod can go to: the one it was built on, then every other one this app knows. */
function useModMachines(homeEnvironmentId: EnvironmentId): ReadonlyArray<ModMachine> {
  const { environments } = useEnvironments();
  const statuses = useAtomValue(modStatusesAtom);
  const excluded = useAtomValue(excludedModMachinesAtom);
  const steps = useAtomValue(modMachineStepsAtom);
  const failures = useAtomValue(modMachineFailuresAtom);
  const localEnvironmentId = useAtomValue(localEnvironmentIdAtom);
  const homeVersion = statuses.get(homeEnvironmentId)?.serverVersion;
  return environments
    .filter(
      (environment) =>
        environment.environmentId === homeEnvironmentId ||
        environment.serverConfig?.environment.capabilities.modBuildTransfer === true,
    )
    .map((environment) => {
      const status = statuses.get(environment.environmentId) ?? null;
      const home = environment.environmentId === homeEnvironmentId;
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        home,
        servesThisPage: environment.environmentId === localEnvironmentId,
        connected: status !== null,
        included: home || !excluded.includes(environment.environmentId),
        otherVersion:
          status !== null && homeVersion !== undefined && status.serverVersion !== homeVersion
            ? status.serverVersion
            : null,
        continuesThreads:
          environment.serverConfig?.settings.continueThreadsAfterServerUpdate === true,
        status,
        step: steps.get(environment.environmentId) ?? null,
        failure: failures.get(environment.environmentId) ?? null,
      };
    })
    .toSorted((left, right) => Number(right.home) - Number(left.home));
}

export function ModApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: ModApprovalRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const m = useMessages();
  const { item } = props;
  const display = modApprovalDisplay(item, props.visibility, m);
  const machines = useModMachines(props.environmentId);
  const home = machines.find((machine) => machine.home);

  if (display.kind !== "pending") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "applied"
          ? CheckIcon
          : MinusIcon;
    // Only the build that is applied now has anything left to do on a machine.
    const current =
      display.kind === "answered" &&
      display.outcome === "applied" &&
      home?.status?.build?.buildId === item.preview.buildId;
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
        {current ? (
          <ModMachineRows
            homeEnvironmentId={props.environmentId}
            buildId={item.preview.buildId}
            restarts={item.preview.restartRequired !== false}
            machines={machines}
          />
        ) : null}
      </Collapsible>
    );
  }
  return (
    <PendingModApprovalCard
      environmentId={props.environmentId}
      threadRef={props.threadRef}
      item={item}
      machines={machines}
    />
  );
}

/** Where the applied build stands on each machine, with the one button that finishes it there. */
function ModMachineRows(props: {
  readonly homeEnvironmentId: EnvironmentId;
  readonly buildId: string;
  readonly restarts: boolean;
  readonly machines: ReadonlyArray<ModMachine>;
}) {
  const gt = useGT();
  const rows = props.machines.map((machine) => {
    const applied = machine.status?.build?.buildId === props.buildId;
    return {
      machine,
      applied,
      needsRestart: applied && machine.status?.restartPending === true,
      canRestart: machine.status?.canRestart === true,
    };
  });
  // One machine that simply runs the mod has nothing to tell.
  if (rows.every((row) => row.machine.home && row.applied && !row.needsRestart)) return null;

  return (
    <ul className="flex flex-col gap-1 pt-1 pl-5 text-xs">
      {rows.map(({ machine, applied, needsRestart, canRestart }) => {
        const action =
          machine.step !== null || !takesMod(machine)
            ? null
            : machine.failure !== null
              ? gt("Retry")
              : needsRestart
                ? canRestart
                  ? gt("Restart")
                  : null
                : applied
                  ? null
                  : props.restarts
                    ? gt("Apply and restart")
                    : gt("Apply");
        return (
          <li key={machine.environmentId} className="flex min-w-0 flex-wrap items-center gap-x-2">
            <span className="font-medium text-foreground">{machine.label}</span>
            <span className={machine.failure ? "text-destructive" : "text-muted-foreground"}>
              {machine.step === "copying"
                ? gt("Copying…")
                : machine.step === "waiting"
                  ? gt("Waiting to restart…")
                  : machine.step === "restarting"
                    ? gt("Restarting…")
                    : (machine.failure ??
                      (!machine.connected
                        ? gt("Offline")
                        : machine.otherVersion !== null
                          ? gt("Runs {version}, update it first", {
                              version: machine.otherVersion,
                            })
                          : needsRestart
                            ? canRestart
                              ? gt("Not restarted yet")
                              : gt("Restart T3 Code on that machine to switch to it.")
                            : applied
                              ? gt("Running")
                              : gt("Not applied")))}
            </span>
            {action !== null ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void rollOutMod({
                    source: props.homeEnvironmentId,
                    targets: [machine.environmentId],
                  })
                }
              >
                {action}
              </Button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PendingModApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef | null;
  readonly item: ModApprovalRequestItem;
  readonly machines: ReadonlyArray<ModMachine>;
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
  const [confirming, setConfirming] = useState(false);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [previewOpened, setPreviewOpened] = useState(false);
  // Two clicks can land before a render.
  const inFlight = useRef(false);
  const restarts = item.preview.restartRequired !== false;

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
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        pipe(
          squashAtomCommandFailure(result),
          (failure) => modApprovalFailureMessage(failure, m),
          setError,
        );
      }
      return;
    }
    if (result.value.activation === undefined) return;
    // The card is the applied one from here on; its rows show how each machine gets on.
    void rollOutMod({
      source: props.environmentId,
      targets: props.machines
        .filter((machine) => machine.included && takesMod(machine))
        .map((machine) => machine.environmentId),
    });
  };

  const disabled = submitting !== null || !canAnswer;
  const unproven = !(
    item.preview.verification.stockFailed && item.preview.verification.candidatePassed
  );

  return (
    <section
      data-v2-item-type={item.type}
      aria-label={gt("Apply T3 Code customization: {title}", { title: item.preview.title })}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="text-sm font-medium text-foreground">{item.preview.title}</p>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.preview.intent}</p>
      </div>

      {restarts || unproven || item.preview.warnings.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
          {restarts ? (
            <p>
              <T>Applying it restarts T3 Code, which interrupts running threads.</T>
            </p>
          ) : null}
          {unproven ? <p className="text-warning">{item.preview.verification.summary}</p> : null}
          {item.preview.warnings.map((warning) => (
            <p key={warning} className="text-warning">
              {warning}
            </p>
          ))}
        </div>
      ) : null}

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

      <div className="flex min-w-0 items-center justify-end gap-2">
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled}
          onClick={() => void send("decline")}
        >
          {submitting === "decline" ? gt("Declining...") : gt("Decline")}
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void send("preview")}
        >
          {submitting === "preview" ? gt("Starting preview...") : gt("Preview")}
        </Button>
        <Button size="xs" disabled={disabled} onClick={() => setConfirming(true)}>
          {submitting === "apply" ? gt("Applying...") : gt("Apply")}
        </Button>
      </div>

      <ModApplyDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={item.preview.title}
        restarts={restarts}
        machines={props.machines}
        onInclude={setModMachineIncluded}
        onConfirm={() => {
          setConfirming(false);
          void send("apply");
        }}
      />
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
