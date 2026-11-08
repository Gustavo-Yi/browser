# 客户端界面集成（本地测试版）

## 本次实现

- 将已确认的黑白分组界面接入正式 Electron 客户端；不再运行模拟账号模型。
- 浅色 / 深色 / 跟随系统、RGB 滑块和数字输入、预设颜色与恢复默认。
- 环境列表、搜索、创建 / 批量创建、改名、单个启动 / 关闭、按序启动、关闭全部、数据目录与版本更新均接入固定 IPC。
- 移除红框中的所有指定说明文字、侧栏预览标识和页脚左侧整段文字；保留实际状态提示、错误反馈和版本号。移除仅限演示的重置、假更新与假目录功能。

## 数据兼容边界

本次未改 package name、productName、appId、userData 定位、已有 ID、profiles 路径、账号存储格式与迁移逻辑。`lib/storage.js`、`lib/windows-processes.js`、`lib/security.js` 与本轮修改前一致。未访问或修改已有 WhatsApp 登录目录。

新增单个关闭接口沿用原有进程身份核对与 WM_CLOSE，不使用强制终止。状态以主进程实际结果为准；失败时不会把仍运行的 Chrome 显示成已关闭。删除仅移除列表记录，数据目录仍保留。

## 开发和本地体验

源码位于 `ui/`。`scripts/build-ui.cjs` 构建离线 `renderer.js`、`style.css`，生产界面仍由 `main.js` 加载同一个本地 `index.html`；CSP、sandbox、contextIsolation 均保留。

```powershell
cd D:\develop\browser
npm run preview:local
```

此命令使用新临时目录启动真实客户端，可点击新界面操作真实的独立测试 Chrome；不会加载已有账号。不要用 `npm start` 做隔离测试，因为它使用正式默认数据目录。

## 回归命令

```powershell
npm test
npm run test:electron
npm run test:electron:real
npm run test:chrome
```

普通 / 损坏配置 Electron 检查使用真实页面、preload、IPC 和数据存储，替换浏览器进程与更新器以覆盖失败情形。真实 Chrome UI 测试验证点击到实际进程的闭环；独立 Chrome 回归验证 Cookie、Local Storage、IndexedDB 的隔离与重开持久化。所有账号和浏览器数据均为新临时测试数据，未使用真实 WhatsApp 会话。

## 发布状态

后续的紧凑桌面比例、模式小字清理和主题切换性能优化见 `UI-QUALITY.md`；数据路径及业务逻辑未因此改变。

新界面本地运行与回归已通过，未覆盖安装用户的正式客户端。2.2.13 发布说明与独立升级验证流程见 `RELEASE-2.2.13.md`；正式发布状态以 GitHub Release 和 Actions 结果为准。

Windows EXE 写入错误已处理，新的本地测试安装包位于 `dist-local/YT多开浏览器 Setup 2.2.13.exe`。打包过程为 EXE 的暂时性 `open` 失败添加有界重试；保留 ASAR 完整性校验，不修改系统防护，也不结束其他进程。详细原因、重放命令及测试边界见 `PACKAGING.md`。

已从新安装包提取实际程序，使用独立临时 userData 验证启动、外观设置跨进程保存、真实 Chrome 多开与正常关闭。没有覆盖安装原客户端，没有修改 Windows 安装登记或快捷方式。安装向导及真实用户配置上的升级尚未执行。旧 `dist-fix/` 安装包未包含新界面，后续请以 `dist-local/` 为本次打包结果。
