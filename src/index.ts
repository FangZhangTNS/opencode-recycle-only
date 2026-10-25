import { Plugin } from "@opencode/plugin"
import { findBlockedDelete } from "./matcher"

// recycle-only (OpenCode V2 only) — block permanent deletes, move nothing.
//
// The plugin never rewrites a command and never touches the filesystem. It
// denies the call and tells the model why, so the model picks a recoverable
// path on its own (Recycle Bin / trash). A rewritten command would look like
// its own output and invite retries; a denial with a reason does not.
//
// Two layers:
//   1. ctx.permission.hook("evaluate") — action "shell", runs for allow/ask
//      decisions, so a default allow policy cannot bypass it.
//   2. ctx.shell.hook("create.before") — throw for shells spawned without a
//      permission evaluation. Layer 1 runs first, so this never doubles up.

function denyMessage(hit: { verb: string; sample: string }): string {
  return [
    `Blocked by the recycle-only policy: "${hit.sample}" performs a permanent delete (${hit.verb}).`,
    "This is a policy denial, not command output. Do not retry the same command.",
    "Use a recoverable delete instead:",
    "- Windows: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<abs path>','OnlyErrorDialogs','SendToRecycleBin') (folders: DeleteDirectory('<abs dir>','OnlyErrorDialogs','SendToRecycleBin'))",
    "- macOS/Linux: trash <path> or gio trash <path>",
    "Remote deletes over ssh must run from an uploaded script after explicit approval.",
  ].join("\n")
}

export default Plugin.define({
  id: "recycle-only",
  async setup(ctx) {
    console.info("[recycle-only] plugin loaded (V2).")

    await ctx.permission.hook("evaluate", (event) => {
      if (event.action !== "shell") return
      for (const resource of event.resources) {
        const hit = findBlockedDelete(resource)
        if (!hit) continue
        event.effect = "deny"
        event.message = denyMessage(hit)
        return
      }
    })

    await ctx.shell.hook("create.before", (event) => {
      const hit = findBlockedDelete(event.command)
      if (hit) throw new Error(denyMessage(hit))
    })
  },
})
