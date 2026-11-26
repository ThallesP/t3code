// The mod the video's agent makes: each sidebar thread shows its git branch. serve.mjs builds the
// real web client with and without it, and the scripted agent applies the same edits on camera.
export const MOD_FILE = "apps/web/src/components/sidebar/SidebarThreadRow.tsx";
export const MOD_ID = "sidebar-branches";

export const MOD_EDITS = [
  {
    old: `  const metaLineEmpty =
    props.environmentLabel === null &&
`,
    new: `  const metaLineEmpty =
    props.environmentLabel === null &&
    !checkoutThread.branch &&
`,
  },
  {
    old: `          <span className="min-w-0 flex-1 truncate">{props.environmentLabel}</span>
        </>
      ) : (
        <span className="flex-1" />
      )}
      {terminalStatusIcon}`,
    new: `          <span className={checkoutThread.branch ? "shrink-0" : "min-w-0 flex-1 truncate"}>
            {props.environmentLabel}
          </span>
        </>
      ) : null}
      {checkoutThread.branch ? (
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <GitBranchIcon aria-hidden className="size-3 shrink-0 text-icon-muted" />
          <span className="min-w-0 truncate">{checkoutThread.branch}</span>
        </span>
      ) : props.environmentLabel === null ? (
        <span className="flex-1" />
      ) : null}
      {terminalStatusIcon}`,
  },
];

export const applyEdits = (text) =>
  MOD_EDITS.reduce((current, edit) => {
    if (!current.includes(edit.old)) throw new Error(`mod edit no longer applies:\n${edit.old}`);
    return current.replace(edit.old, edit.new);
  }, text);
