// Minimal regression check for the scanner. Run: node --test matcher.test.ts
// Every blocked case must stay blocked; every allowed case is a false positive
// that used to fire under the old substring-matching implementation.

import { test } from "node:test"
import assert from "node:assert/strict"
import { findBlockedDelete } from "./matcher.ts"

const blocked = [
  "rm -rf build",
  "rm build/foo.txt",
  "cd x && rm -rf y",
  "sudo rm -rf /tmp/x",
  "sudo -u root rm -rf /tmp/x",
  "FOO=1 rm x",
  "timeout 5 rm -rf x",
  "find . -name '*.tmp' -exec rm {} +",
  "find . -name '*.tmp' -delete",
  "ls | xargs rm -f",
  "del /f /q C:\\tmp\\a.txt",
  "rd /s /q C:\\tmp\\x",
  "Remove-Item -Recurse -Force .\\src",
  "ri -Recurse .\\src",
  "Get-ChildItem .\\x | Remove-Item",
  "[System.IO.File]::Delete('x')",
  "[System.IO.Directory]::Delete('x')",
  'python -c "import shutil; shutil.rmtree(\'x\')"',
  'node -e "require(\'fs\').rmSync(\'x\',{recursive:true})"',
  'bash -c "rm -rf x"',
  'pwsh -Command "Remove-Item x -Force"',
  "cmd /c del x",
  "Clear-RecycleBin -Force",
  "powershell -EncodedCommand ABCDEF",
]

const allowed = [
  'grep -r "rm " src',
  "echo rm foo",
  "Get-Content rm.txt",
  'Select-String -Pattern "Remove-Item" -Path a.ps1',
  'git commit -m "remove unused rm logic"',
  "cat README.md | grep delete",
  "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('x','OnlyErrorDialogs','SendToRecycleBin')",
  "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory('x','OnlyErrorDialogs','SendToRecycleBin')",
  "trash build/foo.txt",
  "gio trash x",
  'Get-ChildItem | Where-Object { $_.Name -like "rm*" }',
  'python -c "import os; print(os.listdir(\'.\'))"',
  "npm run build",
  'ls *.md | xargs grep "del "',
  'Write-Host "Remove-Item is blocked"',
  "make rm",
  'bash script.sh',
  "echo 'closing the rm gate' >> notes.md",
]

for (const command of blocked) {
  test(`blocks: ${command}`, () => {
    const hit = findBlockedDelete(command)
    assert.ok(hit, `expected a hit for ${command}`)
  })
}

for (const command of allowed) {
  test(`allows: ${command}`, () => {
    const hit = findBlockedDelete(command)
    assert.equal(hit, null, `unexpected hit ${JSON.stringify(hit)} for ${command}`)
  })
}
