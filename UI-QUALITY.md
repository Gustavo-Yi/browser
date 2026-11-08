# 界面比例与外观切换优化（2026-11-08，本地）

## 修改

- 删除模式选项下方“已固定为…”和“跟随系统 · 当前为…”的小字。保留模式名称、选中状态、RGB 数值和实际错误反馈。
- 不改变 Windows 显示缩放或 Electron 页面缩放（实测 zoomFactor = 1）。改用紧凑桌面尺寸：1280 宽测试窗口的主标题从 42 px 调至 28 px，列表行高从 82 px 调至 62 px，外观对话框宽度从 570 px 调至 480 px；同步调整按钮、间距和窄窗口布局。
- 外观状态移到独立 Provider，只有侧栏快捷控件及外观面板订阅，调色不再让账号列表跟着 React 重渲染。
- 颜色立即显示，不对背景、边框和文字颜色执行渐变过渡；移除叠加的大面积 backdrop-filter，保留圆角、边缘高光、阴影和按钮轻微位移动效。弹窗采用不透字的中性底色。
- RGB 拖动后 160 ms 合并保存；关闭外观面板、页面隐藏或退出前立即保存最后一次设置。仍只使用原来的 `yt-browser.appearance.v1` 键，不迁移账号或 Chrome profile。
- 独立预览不再强制关闭硬件加速，与正式 EXE 默认行为一致；也单独覆盖软件渲染回退测试。

## 可重复测试

```powershell
cd D:\develop\browser
npm test
npm run test:electron
npm run test:ui-quality
npm run test:ui-quality -- --software
npm run test:chrome
npm run dist -- --publish never --config.directories.output=dist-local
npm run test:packaged
npm run preview:local
```

所有测试使用新建临时目录和测试记录，不读取正式 WhatsApp 登录数据；不要用 `npm start` 代替隔离预览。

## 本机测量

同一 Electron 45.2.3、同一 1280 × 800 请求窗口、同样的软件渲染模式，使用实际主进程、preload、UI，仅把外部 Chrome 操作替换成不可启动的测试实现。

| 项目 | 修改前 | 修改后 |
| --- | --- | --- |
| 4 次主题 / 预设色切换，样式达到目标颜色 | 109–407 ms | 12–17 ms |
| 200 条测试记录、60 次逐帧 RGB 输入的保存次数 | 60 | 1 |
| 上述 RGB 测试的主线程 TaskDuration 增量 | 7.17 s | 1.78 s |
| 上述 RGB 测试的 ScriptDuration 增量 | 1.12 s | 0.08 s |

硬件加速开启的独立检查也通过，切换样式达到目标颜色为 11–21 ms。以上是本机单轮实验数据，不是所有设备的帧率保证；颜色到位用计算样式与 requestAnimationFrame 检测，耗时用 DevTools Performance 指标采样。

布局检查请求 1280 × 800、1024 × 700、920 × 640，系统 DPI 舍入及主窗口最小高度约束下，实际渲染区域分别为 1281 × 802、1025 × 702、921 × 682。均没有横向溢出，外观面板完整显示、无需内部滚动。另覆盖拖动后立即关闭面板、侧栏切换后立即重载的最后值保存。

回归结果：31 项单元用例、41 项 Electron 普通 / 损坏配置检查、两种渲染模式下的界面质量检查、真实双 Chrome 数据隔离及重开持久化检查，全部通过。重新构建安装包后，提取实际 EXE 的 14 项检查也通过，覆盖 ASAR 完整性、跨进程主题保存、真实双开、单独关闭及关闭全部。未在真实 WhatsApp 会话上操作。

## 数据与发布边界

本轮界面优化没有修改 `main.js`、`preload.js`、`lib/storage.js`、`lib/account-manager.js`、`lib/windows-processes.js`、`lib/security.js` 和仓库 `accounts.json`，修改前后 SHA-256 一致。界面验收阶段没有启动默认正式数据目录或覆盖安装；后续发布流程见 `RELEASE-2.2.13.md`。

本地证据、源文件备份、前后截图及构建日志保存在此次任务的 `density-performance` 工件目录，不随安装包分发。

当时的本地预发布安装包：`D:\develop\browser\dist-local\YT多开浏览器 Setup 2.2.13.exe`。正式 CI 构建的哈希以 Release 的更新信息为准。
SHA-256：`8e0c3461630c15c250933d71642034fc3bd8aff30cabecb9175884254ce6aabe`。
安装包未签名；测试直接运行提取后的实际 EXE，不执行安装向导，也不改现有安装登记或快捷方式。
