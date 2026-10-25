**简体中文** | [English](./README.md)

# opencode-recycle-only

OpenCode V2 插件：阻断永久删除。不改写命令、不移动文件、不碰文件系统。

## 为什么只阻断，不改写成回收站

最直觉的做法是拦下 `rm` 改写成 trash 命令。这在实践里失效，原因只有一个：改写后的命令照样执行，模型看到一次成功的工具调用，输出是一段提示。返回结果里没有任何信息说明这段话来自插件而不是它自己写的命令。它会换个写法再试，或者更糟——以为文件已经删掉了。

拒绝没有歧义。工具调用以失败返回，消息明确写着这是策略拒绝而不是命令输出，模型自己去选可恢复的路径。文件系统全程不被触碰，插件也就不可能损坏文件、和模型抢同一个路径、或者只完成一半的移动。

## 拦什么

删除动词只在命令位置才算数。引号里的文本、非 shell 命令的参数、叙述性文字一律不匹配。

| 输入 | 结果 |
| --- | --- |
| `rm -rf build` | 拦 |
| `cd x && rm -rf y` | 拦 |
| `sudo rm -rf /tmp/x` | 拦 |
| `find . -name '*.tmp' -delete` | 拦 |
| `find . -name '*.tmp' -exec rm {} +` | 拦 |
| `ls \| xargs rm -f` | 拦 |
| `del /f /q C:\tmp\a.txt`、`rd /s /q C:\tmp\x` | 拦 |
| `Remove-Item -Recurse -Force .\src`、`ri .\src` | 拦 |
| `Get-ChildItem .\x \| Remove-Item` | 拦 |
| `[System.IO.File]::Delete('x')` | 拦 |
| `bash -c "rm -rf x"`、`pwsh -Command "Remove-Item x"`、`cmd /c del x` | 拦 |
| `python -c "shutil.rmtree('x')"`、`node -e "fs.rmSync('x')"` | 拦 |
| `Clear-RecycleBin -Force` | 拦 |
| `powershell -EncodedCommand ...` | 拦（无法解析） |
| `grep -r "rm " src` | 放 |
| `echo rm foo` | 放 |
| `Select-String -Pattern "Remove-Item"` | 放 |
| `git commit -m "remove unused rm logic"` | 放 |
| `trash build/foo.txt`、`gio trash x` | 放 |
| `DeleteFile(...,'SendToRecycleBin')` | 放 |
| `python -c "print(os.listdir('.'))"` | 放 |

## 工作方式

两个进程内钩子：

1. `ctx.permission.hook("evaluate")` —— 对 `shell` 动作把 `effect` 改成 `deny` 并给出原因。权限钩子对 `allow` 和 `ask` 决策都运行，默认全允许的策略绕不过去。命令不会到达 shell。
2. `ctx.shell.hook("create.before")` —— 对未经权限评估就 spawn 的 shell 抛错。正常情况下第一层先命中，两层不会重复报错。

拒绝消息原文：

```text
Blocked by the recycle-only policy: "rm -rf build" performs a permanent delete (rm).
This is a policy denial, not command output. Do not retry the same command.
Use a recoverable delete instead:
- Windows: Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('<abs path>','OnlyErrorDialogs','SendToRecycleBin') (folders: DeleteDirectory('<abs dir>','OnlyErrorDialogs','SendToRecycleBin'))
- macOS/Linux: trash <path> or gio trash <path>
Remote deletes over ssh must run from an uploaded script after explicit approval.
```

## 安装

```bash
opencode plugin add opencode-recycle-only
```

或在 `opencode.json` 里指向本地目录：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/opencode-recycle-only"]
}
```

需要 OpenCode V2（开发与验证基于 2.0.29）。不支持 V1：V1 的钩子名和插件签名都不同。

插件不读配置、不写文件、不保留状态。行为只由代码决定。

## 覆盖边界

刻意不处理：

- 编辑、patch、write。管这些意味着每次文件操作都需要有人在场盯着；插件只守 shell 删除。
- `git clean`、`git rm`、`rsync --delete`、`robocopy /MIR`、磁盘与分区工具。它们用自己的动词销毁数据，不在 shell 删除的范围内。
- 写进脚本文件、稍后执行的删除（`echo "rm x" > a.sh && bash a.sh`）。
- 无法解析的编码载荷直接拦，不做内容检查。

这个插件是君子协议，不是沙箱。它挡住误删，挡不住有恶意的模型。需要硬性、可审计的策略时，配合 OpenCode 自带的 `permissions` 规则一起用。

## 开发

```bash
npm install
npm test        # node --test，42 条断言
npm run typecheck
```

`src/matcher.ts` 不导入 OpenCode，是纯扫描器，可以独立测试。

## 许可证

MIT
