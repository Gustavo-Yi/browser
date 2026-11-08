# Windows 本地打包修复与验证

## 原因与修复范围

先前错误出现在 electron-builder `addWinAsarIntegrity` 写入 EXE 资源时：`UNKNOWN: unknown error, open ...YT多开浏览器.exe`。

本轮检查排除了输出 EXE 与正在运行的 Electron 使用硬链接的情况。独立临时文件上的资源改写和一次原始构建可以成功；用 Windows 文件共享锁可以重现打开失败。历史发生时具体占用者没有被捕获，不能断言一定是某个杀毒软件或进程。

`scripts/build-windows.cjs` 仅在打包 Node 进程内包装锁定版本的资源写入函数，调用 `scripts/executable-write-retry.cjs`：

- 只在 EXE 本身的 `open` 阶段收到 `UNKNOWN` / `EBUSY` / `EPERM` / `EACCES` 时重试。打开失败尚未截断或写入文件。
- 重试等待依次为 200、400、800、1600、3200、5000 ms；最多额外 6 次，总等待 11.2 秒。一直失败仍以原错误终止构建，不假报成功。
- 不重试部分写入、磁盘空间不足、PE 解析异常或其他路径的错误。
- ASAR 完整性资源仍由原始 builder 写入；未关闭校验、未禁用系统防护、未结束用户进程、未修改 node_modules 中的文件。
- 原生 Windows 打包优先使用已安装且版本匹配的 Electron，避免重复下载相同运行时；明确覆盖运行时或架构时保留 builder 默认处理。
- 默认 `--publish never`，只有明确传入发布参数才改变此行为。本轮全部构建均显式 `--publish never`。

实际完整 NSIS 构建中再次出现相同 `UNKNOWN/open`，日志显示一次 200 ms 重试后资源写入成功；后续重复完整构建也成功。

## 重放命令

在 `D:\develop\browser` 中运行：

```powershell
npm test
npm run dist -- --publish never --config.directories.output=dist-local
npm run test:packaged
npm run test:chrome
```

安装包：`D:\develop\browser\dist-local\YT多开浏览器 Setup 2.2.13.exe`。

`test:packaged` 会把安装包内的实际应用载荷解压到一个新的临时目录，再用 `--user-data-dir=<新临时目录>` 启动真实打包 EXE。调试端口也只由测试命令添加，随机端口且绑定 loopback；正式客户端源码没有新增调试或测试后门。测试结束正常关闭其创建的 Chrome 与客户端，临时目录保留供复核。

## 验证覆盖

- 31 项单元 / 故障注入检查，包括真实 Windows 共享锁和有界重试。
- 打包 ASAR 上的 41 项普通 / 损坏配置 Electron 检查。
- 安装包实际载荷的 14 项检查：EXE 和 ASAR 与构建输出一致、ASAR 完整性 SHA256、生产源码一致、排除账号 / profile / 测试脚本、独立启动、preload / sandbox、版本、主题与跨进程保存、真实双 Chrome 多开、单独关闭不影响另一 PID、全部退出、测试目录与 ID 保留。
- 两个新临时 Chrome profile 的 Cookie、Local Storage、IndexedDB 隔离和重开持久化回归。

## 未改变与未执行

- 本次仅改打包脚本、测试与说明，不改客户端主进程 / preload、界面、AccountManager、数据路径、账号 ID、存储和迁移逻辑。
- 所有验证都使用新临时数据，没有读取或修改已有 WhatsApp 会话。
- 未运行 NSIS 安装向导，未覆盖已有安装，未测试真实用户配置上的升级；未创建或覆盖桌面快捷方式 / 安装登记。
- 安装包未配置代码签名，属于未签名的本地测试产物。
- 未提交、未推送、未发布。
