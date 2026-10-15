# DSH Web Channels

把 Gemini 和 Perplexity 网页聊天接入 DSH Desktop，使用网页当前选择的模型，支持半自动、全自动和 DSH 工具调用。无需 API Key。

> 社区项目，与 DeepSeek、Google、Perplexity 均无隶属关系。网页会员与 API 是不同服务；使用额度和模型可用性以网站为准。

## 功能

| DSH 模型 ID | 工作方式 |
| --- | --- |
| `gemini-web` | 半自动：填写消息，在通道网页手动发送 |
| `gemini-web-auto` | 全自动：自动发送消息并接收回复 |
| `perplexity-web` | 半自动：填写消息，在通道网页手动发送 |
| `perplexity-web-auto` | 全自动：自动发送消息并接收回复 |

- 保留通道网页当前模型，不打开模型菜单，也不代用户切模型。
- 后续回合尽量只传新增内容；首次、规则变化和恢复时传送必要的工具定义、指令和历史。
- 将合法工具请求转换成 DSH 原生工具调用，按完整参数 Schema 校验；权限和审批仍由 DSH 决定。
- 保留 Markdown 标题、代码语言与缩进、表格、嵌套列表、引用、链接和公式。
- 每个 DSH 对话、每个站点使用独立的工作标签；内部摘要和标题使用临时标签。
- 重启时核对标签、URL 和回复哈希，符合条件则恢复；否则从 DSH 历史建立新标签。
- Perplexity 长消息分段；网页明确报告的截断、频控、网络或上下文错误会反馈给 DSH。

## 环境与验证范围

- 已验证：DSH Desktop 2.0.17 / Harness 0.2.0-rc.2、Windows、Microsoft Edge。
- 插件要求 Node.js 22 或以上的宿主运行时。DSH Desktop 使用其内置运行时，不需要另外升级全局 Node/npm。
- 需要自己的 Gemini / Perplexity 网页账号。登录、验证码及网站验证由使用者在浏览器完成。
- 本项目不包含 DeepSeek 通道；可另装 [LittleCar30 的 DeepSeek 插件](https://github.com/LittleCar30/dsh-deepseek-web)。

## 安装

推荐安装 [Releases](https://github.com/dv868/dsh-web-channels/releases) 的固定版本 tgz，避免 Git 仓库安装依赖本机 Git。
GitHub 的 “Source code” 压缩包是源码，不是插件 tgz。

1. 下载 `dsh-web-channels-0.2.2.tgz`，核对同一 Release 的 `SHA256SUMS.txt`。
2. 在 DSH 的 “Open DSH Terminal” 记录 `dsh --version`、`$env:DSH_HOME` 和 CLI 可执行文件位置：
   `(Get-Command dsh).Source`。保留该终端，或使用保留了相同 DSH 环境的外部终端。
3. 备份 desktop profile 配置，完全退出 DSH Desktop，再安装。桌面运行时可能独占 profile；无法从保留的终端执行时，按本机 DSH 版本提供的停机安装方法操作。
4. 将下面的示例路径替换为你下载文件的绝对路径，使用正斜杠：

   ```powershell
   dsh plugin --profile desktop add "file:C:/Downloads/dsh-web-channels-0.2.2.tgz"
   ```

5. 重新启动 DSH Desktop，选择上表模型。
6. 首次发送时会启动独立 Edge；在通道窗口自行登录后继续。

如果 CLI 报 profile 锁、pnpm 缺失或不支持参数，保留完整报错，用
`dsh plugin --profile desktop --help` 核对当前版本语法。不要同时启动多个安装过程。

源码中的 `private: true` 只防止误发布到 npm，不影响 GitHub 公开、打包或 DSH 安装。

## 使用

1. 在 DSH 建立对话，选择带 `-auto` 的全自动模型。
2. 想选择网页型号时，先使用半自动模式发一句话，在对应的通道标签里切换型号并点击发送，再回 DSH 选全自动。
3. 同一站点的半自动和全自动共享该 DSH 对话的工作标签。
4. 只在 DSH 点击切换对话不会操作网页；下一次发消息时才复用或建立对应标签。
5. 半自动模式的每轮工具结果、内部摘要、标题和长消息分段也需要在网页手动发送。

网页新标签可能采用网站默认型号。DSH 中的“网页选择”报告是按钮显示名称，不保证服务端实际型号，也不自动同步其它标签的选择。
网页账号能否选择某一型号，由账号权限和网站决定。

## 配置

在 desktop 的 `cordis.patch.yml` 中增加或合并本插件配置；不要重复添加同 ID 的覆盖：

```yaml
- id: llm-web-channels
  config:
    debugPort: 9336
    managedPort: 9336
    perplexityEntryUrl: https://www.perplexity.ai/
    perplexityAccountLabel: ''
```

默认使用 9336，避开 DeepSeek 网页通道常用的 9333。
不要把端口配置为其它无关浏览器的调试端口。浏览器登录态不会在不同用户目录间自动共享。

| 配置项 | 默认值 | 含义 |
| --- | --- | --- |
| `debugPort` | 9336 | 优先连接的本机 CDP 端口 |
| `managedPort` | 9336 | 无可用连接时启动的独立 Edge 端口 |
| `autoStartBrowser` | true | 允许自动启动独立 Edge |
| `geminiEnabled` / `perplexityEnabled` | true | 启用站点通道 |
| `timeoutMs` | 600000 | 每轮网页等待上限，毫秒 |
| `perplexityEntryUrl` | 官方网站 | 可选的 HTTPS 登录入口，必须最终进入官方 Perplexity |
| `perplexityAccountLabel` | 空 | 自定义入口可选的登录标识文字，不含密码或令牌 |
| `compactPrompts` | true | 精简工具说明，保留实际参数校验 |
| `restoreSessions` | true | 保存及恢复会话绑定索引 |
| `stateDirectory` | DSH Home 下 web-channels | 索引存储目录 |
| `responseStableMs` | 2500 | 回复结束后的稳定等待时间 |

有自有登录入口时，可在个人配置里设置其 HTTPS 地址和可见账号标识；不要把个人入口、账号标识或凭证提交到公开仓库。
更改入口不会转移 Cookie，也不会自动完成登录。插件不为账号开通或绕过会员权限。

## 数据与取消

- 独立 Edge 登录目录：`%LOCALAPPDATA%/DshWebChannels/edge-profile/`。
- 会话索引：`$DSH_HOME/web-channels/`，仅保存消息 ID、哈希、标签标识和对话 URL 路径，不保存聊天正文、工具结果、Cookie 或令牌。
- 处理任务所需的宿主指令、对话和工具结果会发送到所选网页服务；网页按该服务规则保存聊天历史。
- 取消会尝试停止该回合生成，或清理插件填写且未被使用者修改的草稿。失败或取消不推进消息游标，不自动重发已发送消息。
- 摘要和标题的临时标签会关闭；关闭标签不等于删除网站服务器上的对话记录。
- 插件断开时不关闭共享浏览器，也不删除登录目录。DeepSeek 登录目录不在本插件管理范围内。

## 限制与已知问题

- 文字首版，不支持附件、图片、语音、逐字流式或准确 token 计量。
- 页面改版可能影响输入、模型名、正文或结束状态识别；没有明确错误提示时不能保证检测所有截断。
- 不同网页模型遵守工具协议的能力不同；格式错误最多纠错一次，不从普通正文或示例提取工具执行。
- 普通聊天和搜索路径已测试，Research、Computer 等其它网页模式未验证。
- 同一站点请求串行，不同站点独立；长消息分段会增加请求次数。
- Gemini 的真实宿主工具验收曾在 300 秒等待设置下最终汇报超时，接续原会话后收到完整报告；默认等待上限为 600 秒。网页响应速度无法保证。
- 恢复遇到关闭标签、内容变化、忙碌标签或上下文压缩时可能建立新标签；旧工作标签保留。

## 开发与测试

克隆或下载源码后，在本地项目内安装依赖。DSH 相关 peer 依赖由宿主提供；
独立运行测试时，可按需要在本地安装对应宿主版本的 peer 依赖，不要升级 DSH 本体来满足测试。

```sh
pnpm install
pnpm test
```

`tests/*.test.js` 是离线回归；`tests/*fixtures.mjs` 是独立 DOM 夹具，需要先有运行中的 CDP 浏览器，
默认连接 9336，可通过 `DSH_WEB_CHANNELS_TEST_PORT` 指定。它们只新建并关闭测试标签，不需要网站账号。
本地打包使用 `pnpm pack`。

## 来源与许可

MIT 许可，见 [LICENSE](LICENSE)。

感谢 [LittleCar30/dsh-deepseek-web](https://github.com/LittleCar30/dsh-deepseek-web) 提供的参考实现和设计思路。
本项目面向 Gemini / Perplexity 适配，参考了辅助请求隔离、压缩接续和失败不推进游标等机制；
未直接移植 DeepSeek 的 DSML、SSE 协议或 token 预算。对照记录见 [UPSTREAM.md](UPSTREAM.md)。

本项目由 dv868 发起并使用 Codex 辅助开发。问题与兼容性反馈请提交 [Issues](https://github.com/dv868/dsh-web-channels/issues)，
请移除日志中的对话、私人路径、账号和凭证。

