# YT 多开浏览器 2.2.13

## 更新内容

- 正式客户端使用新的紧凑黑白界面，支持浅色、深色、跟随系统和 RGB 自定义主题色。
- 删除演示说明及多余的模式提示，优化桌面比例和主题切换响应。
- 保留 Chrome 独立多开；增加指定环境正常关闭，关闭前核对进程身份，不强制终止其他环境。
- 保留原有账号 ID、数据路径、Chrome 登录状态和用户配置；配置损坏或发生外部修改时不覆盖原件。
- 加固 Electron 页面隔离与 IPC 参数校验，更新依赖。
- 修复构建时 EXE 暂时被占用导致的写入失败，保留完整性校验。

## 升级方式

正常关闭各个 Chrome 环境后，在原来已安装的客户端点击“更新”，等待下载完成，再点击“完成更新”或“重启并安装”。无需先卸载，也不要删除数据目录。独立测试窗口不用于正式升级。

## 发布验证

- `Build and Release`：版本标签与 package 版本匹配、单元测试、Electron UI 测试，通过后上传草稿版本。
- 正式发布后运行 `Verify Published Windows Update`：在一次性的 GitHub-hosted Windows 测试机上安装 2.2.12，通过其原有 UI 检查、下载并执行真实 NSIS 升级，验证安装后自动重启、版本和文件一致、数据目录和账号 ID 不变。
- 在该测试机创建两个真实 Chrome 测试 profile，验证升级前后的 Cookie、Local Storage、IndexedDB 保留，以及新版多开、单独关闭、主题保存和“已是最新版”检查。
- `test/published-update.cjs` 有 GitHub-hosted 专用保护，不允许在开发电脑或 self-hosted runner 上执行真实安装测试。
- 结果、更新日志和截图保存在 Actions 的 `windows-update-verification` 工件；浏览器 profile 不上传。

安装包尚未配置代码签名。所有回归账号均为测试数据，发布和验证不读取用户的 WhatsApp 会话。
