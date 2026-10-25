**English** | [简体中文](./README.zh-CN.md)

# opencode-recycle-only

An OpenCode V2 plugin that blocks permanent deletes. It never rewrites a command, never moves a file, and never touches the filesystem.

## Why block instead of rewrite

The obvious design is to intercept `rm` and rewrite it into a trash command. That design fails in practice for one reason: the rewritten command still executes, so the model sees a successful tool call whose stdout is a notice. Nothing in the result tells the model that the notice came from a plugin rather than from the command it composed. It retries with another spelling, or worse, assumes the file is gone.

A denial is unambiguous. The tool call comes back as a failure, the message states that this is a policy denial and not command output, and the model picks a recoverable path itself. Keeping the filesystem untouched also means the plugin cannot corrupt a file, race with the model, or half-apply a move.

## What it blocks

A delete verb counts only when it sits in command position. Text inside quotes, arguments of non-shell commands, and prose never match.

| Input | Result |
| --- | --- |
| `rm -rf build` | blocked |
| `cd x && rm -rf y` | blocked |
| `sudo rm -rf /tmp/x` | blocked |
| `find . -name '*.tmp' -delete` | blocked |
| `find . -name '*.tmp' -exec rm {} +` | blocked |
| `ls \| xargs rm -f` | blocked |
| `del /f /q C:\tmp\a.txt`, `rd /s /q C:\tmp\x` | blocked |
| `Remove-Item -Recurse -Force .\src`, `ri .\src` | blocked |
| `Get-ChildItem .\x \| Remove-Item` | blocked |
| `[System.IO.File]::Delete('x')` | blocked |
| `bash -c "rm -rf x"`, `pwsh -Command "Remove-Item x"`, `cmd /c del x` | blocked |
| `python -c "shutil.rmtree('x')"`, `node -e "fs.rmSync('x')"` | blocked |
| `Clear-RecycleBin -Force` | blocked |
| `powershell -EncodedCommand ...` | blocked (not analyzable) |
| `grep -r "rm " src` | allowed |
| `echo rm foo` | allowed |
| `Select-String -Pattern "Remove-Item"` | allowed |
| `git commit -m "remove unused rm logic"` | allowed |
| `trash build/foo.txt`, `gio trash x` | allowed |
| `DeleteFile(...,'SendToRecycleBin')` | allowed |
| `python -c "print(os.listdir('.'))"` | allowed |

## How it works

Two hooks, both in-process:

1. `ctx.permission.hook("evaluate")` — for `shell` actions, sets `effect = "deny"` and supplies the reason. Permission hooks run for `allow` and `ask` decisions, so a default allow policy does not bypass the check. The command never reaches the shell.
2. `ctx.shell.hook("create.before")` — throws for shells spawned without a permission evaluation. The first layer normally fires first, so the two never double-report.

The denial message, verbatim:

```text
Blocked by the recycle-only policy: "rm -rf build" performs a permanent delete (rm).
This is a policy denial, not command output. Do not retry the same command.
Use a recoverable delete instead:
- Windows: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<abs path>','OnlyErrorDialogs','SendToRecycleBin') (folders: DeleteDirectory('<abs dir>','OnlyErrorDialogs','SendToRecycleBin'))
- macOS/Linux: trash <path> or gio trash <path>
Remote deletes over ssh must run from an uploaded script after explicit approval.
```

## Install

```bash
opencode plugin add opencode-recycle-only
```

Or reference a local checkout in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/opencode-recycle-only"]
}
```

Requires OpenCode V2 (developed and tested against 2.0.29). V1 is not supported: V1 uses different hook names and a different plugin signature.

The plugin reads no configuration, writes no files, and keeps no state. Behaviour is decided by the code alone.

## Coverage limits

Deliberately not handled:

- Edits, patches and writes. Blocking those would require a human present for every file operation; the plugin only guards shell deletes.
- `git clean`, `git rm`, `rsync --delete`, `robocopy /MIR`, disk and partition tools. These destroy data through their own verbs and are outside the shell-delete scope.
- Deletes written into a script file and executed later (`echo "rm x" > a.sh && bash a.sh`).
- Encoded payloads that cannot be parsed are blocked rather than inspected.

The plugin is an agreement, not a sandbox. It catches accidental deletes; it does not contain a hostile model. Pair it with OpenCode's own `permissions` rules if you need hard, auditable policy.

## Development

```bash
npm install
npm test        # node --test, 42 assertions
npm run typecheck
```

`src/matcher.ts` has no OpenCode imports; it is a pure scanner and can be tested in isolation.

## License

MIT
