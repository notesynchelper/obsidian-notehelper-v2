# Bi Ji Tong Bu

[English](#english) | [中文](#中文)

---

## English

Bi Ji Tong Bu (笔记同步助手) syncs content you collect through the WeChat official account **「笔记同步助手」(Note Sync Helper)** into your Obsidian vault: articles from WeChat Official Accounts, Xiaohongshu, Dedao, Yuanbao, Zhihu and other platforms, plus chat messages, images and file attachments you forward to the account.

Works on desktop and mobile.

### How it works

1. You follow the WeChat official account **「笔记同步助手」** and bind it to get an **API key**.
2. You share links / messages / files to that account. The backing service fetches and cleans the content.
3. This plugin pulls the processed notes from the service into your vault (manually, on startup, or on a timer you configure).

### ⚠️ Disclosures (please read before installing)

**Account & API key required.** The plugin is a client for the Note Sync Helper service. It does nothing until you enter an API key, which you obtain from the WeChat official account 「笔记同步助手」. Your API key is stored locally in the plugin's `data.json` and sent with every API request to authenticate you (image/attachment downloads from the CDN hosts below do **not** carry the key).

**Network use.** This plugin talks to the following servers (all operated by the plugin author / the Note Sync Helper service, unless noted):

| Host | Purpose |
|---|---|
| `obsidian.notebooksyncer.com` | Main sync API (GraphQL): pull your notes, mark them synced, delete on request; membership/quota status; market version-number check (`/plugversion-market`) |
| `relay-1.bijitongbu.site`, `graph.bijitongbu.site` | Fallback endpoints for the same API (network resilience in mainland China) |
| `relay-1/2/3/4.bijitongbu.site`, `pic.clipfx.app`, `media.clipfx.app`, `media30d.clipfx.app`, `sync.bijitongbu.site`, `www.bijitongbu.site` | Image / attachment hosting, including fallback origin servers. When you enable image or attachment localization, files referenced by your synced notes are downloaded from these hosts into your vault |

Localization downloads the remote URLs your synced notes actually reference: the service normally rewrites media links to the hosts above, but if a note still references a file at its original source (e.g. the source platform's CDN), the plugin downloads it from that original host.

Documentation links in the settings page (`www.notebooksyncer.com`, `shoujidiannao.bijitongbu.site`, `bijitongbu.feishu.cn`) open in your browser only when you click them.

Legacy note: the bundle includes the `@omnivore-app/api` client library (this plugin began as an Omnivore fork). The library's built-in default endpoint (`api-prod.omnivore.app`) is never contacted — the plugin always supplies its own endpoint from the table above. The optional `omnivoreUrl` template variable writes legacy `omnivore.app` links into note text as plain text; no request is ever made to omnivore.app.

**What is sent.** Requests carry your API key, sync cursors/timestamps, and — for explicit actions you trigger — article IDs (e.g. "burn after reading" deletion, clearing server-side storage). The plugin does **not** read, upload, or index the existing notes in your vault; content flows from the service *into* your vault.

**Paid tiers.** The backing service offers a free quota and paid VIP tiers. The settings page shows your membership status and QR codes for subscribing through WeChat. When your membership (or trial) is about to expire or has just expired, a **manual** sync may append one passive line to the sync-status notice — at most once per calendar day, and only when the membership API reports a real expiry date. Clicking it opens a dialog that shows your current membership status, a **statically bundled** payment QR code (scanned with WeChat) and a "refresh status" button. No payment happens inside the plugin, and automatic background syncs never show this line.

**No self-update.** This build contains **no self-update mechanism**. Updates are delivered exclusively through the Obsidian community plugin catalog. After a manual sync the plugin may show a one-line passive reminder under the sync status notice when a newer market version exists (it only fetches a version number from `obsidian.notebooksyncer.com/plugversion-market`); clicking it opens Obsidian's **Settings → Community plugins** page, where you decide whether to update. The plugin never downloads or replaces its own files.

**Static promotion in settings (disclosed).** The settings page shows your membership status and a **statically bundled** QR image (no network load) for purchasing the paid membership; the renewal dialog described above uses a second bundled QR image (the payment page). Both are compiled into the plugin bundle and load with **zero network requests**. Promotional QR images that the service embeds into note content are **stripped by the plugin** before notes are written to your vault — nothing promotional is written into your notes.

**No cross-plugin scripting.** This edition does not invoke other plugins' commands and does not run Templater interpolation; `<% %>` tags in your templates are kept as-is. As a safety guard, files created by this plugin are marked so the Templater plugin (if installed) will not execute template commands found inside synced web content.

### Install & quick start

1. Install the plugin and enable it.
2. Follow the WeChat official account 「笔记同步助手」, get your API key, and paste it into the plugin settings.
3. Click the ribbon icon (or run the `Sync` command). Synced notes land in the folder configured in settings (default `Synced/`).
4. Optional: customize templates (front matter, file naming, merge modes), image/attachment localization, diary links, and sync schedule in the settings page.

Folder and file-name settings provide folder pickers, template-variable insertion and path previews. Quick presets show the proposed changes before applying them and can be undone during the current settings session; existing files are not moved. Email notes and standalone messages can use their own folders, names, front matter and body templates. Each blank profile field inherits the corresponding article setting. In dual-write mode, the merged message copy continues to use the merge settings.

When localization is enabled, notes are saved first while images and attachments continue downloading. The sync completion notice identifies pending background work. Temporary download failures keep the remote links and retry with backoff while Obsidian is running; returning to the foreground resumes due retries. The note context menu offers an immediate localization retry. Previously mislinked same-name attachments cannot be detected or repaired automatically. Mobile attachment localization requires Obsidian 1.12.3 or later and a download host that permits browser access. Files are written in chunks to limit memory use; unsupported hosts or versions retain the remote link for retry.

### Privacy & data location

- Settings (including your API key) are stored in `.obsidian/plugins/wechat-note-helper/data.json` inside your vault.
- Downloaded images/attachments are stored in the attachment folder you configure.
- The service stores the content you shared to the official account until you delete it (the settings page provides a "clear server content" action).

### License

[MIT](LICENSE.md)

---

## 中文

「笔记同步助手」市场版插件：把你通过微信服务号 **「笔记同步助手」** 收集的内容同步进 Obsidian 仓库——支持微信公众号、小红书、得到、元宝、知乎等平台的文章，以及你转发给服务号的聊天记录、图片和文件附件。

桌面端与移动端均可用。

### 工作原理

1. 关注微信服务号 **「笔记同步助手」** 并绑定，获得 **API 密钥**；
2. 把链接 / 消息 / 文件分享给服务号，后台服务抓取并清洗内容；
3. 本插件把处理好的笔记从服务端拉取到你的仓库（手动同步、启动时同步或按你配置的频率定时同步）。

### ⚠️ 使用披露（安装前请阅读）

**需要账号与 API 密钥。** 本插件是「笔记同步助手」服务的客户端，填入 API 密钥前不做任何事。密钥通过微信服务号「笔记同步助手」获取，保存在插件本地 `data.json` 中，每次 API 请求随请求发送用于身份认证（从下表 CDN 域名下载图片/附件时**不**携带密钥）。

**网络访问。** 插件会访问以下服务器（除特别说明外，均由插件作者 / 笔记同步助手服务运营）：

| 域名 | 用途 |
|---|---|
| `obsidian.notebooksyncer.com` | 主同步 API（GraphQL）：拉取笔记、标记已同步、按请求删除；会员/配额状态；市场版本号检查（`/plugversion-market`） |
| `relay-1.bijitongbu.site`、`graph.bijitongbu.site` | 同一 API 的备用端点（大陆网络容灾） |
| `relay-1/2/3/4.bijitongbu.site`、`pic.clipfx.app`、`media.clipfx.app`、`media30d.clipfx.app`、`sync.bijitongbu.site`、`www.bijitongbu.site` | 图片/附件存储（含源站兜底节点）。开启图片或附件本地化后，同步笔记中引用的文件从这些域名下载进仓库 |

本地化下载的是同步笔记中实际引用的远程 URL：服务端通常已把媒体链接改写到上述域名；若某条笔记仍引用原始来源（如源平台 CDN）的文件，插件会从该原始域名下载。

设置页里的文档链接（`www.notebooksyncer.com`、`shoujidiannao.bijitongbu.site`、`bijitongbu.feishu.cn`）仅在你点击时用浏览器打开。

遗留说明：安装包内含 `@omnivore-app/api` 客户端库（本插件源自 Omnivore fork）。该库内置的默认地址（`api-prod.omnivore.app`）永远不会被访问——插件始终传入上表中自己的端点；可选模板变量 `omnivoreUrl` 只会往笔记文本里写历史遗留的 `omnivore.app` 链接（纯文本），不会向 omnivore.app 发起任何请求。

**发送哪些数据。** 请求携带你的 API 密钥、同步游标/时间戳，以及你显式触发的操作对应的文章 ID（如「阅后即焚」删除、清空云端内容）。插件**不会**读取、上传或索引你仓库中已有的笔记；内容只从服务端流向你的仓库。

**付费层级。** 背后服务提供免费额度与付费 VIP 层级。设置页会展示你的会员状态和微信订阅二维码。当会员（或试用）临近到期 / 刚过期时，**手动**同步后可能在同步状态提示下方追加一行弱提醒——每个自然日最多一次，且只在会员接口给出真实到期时间时出现；点开是一个展示当前会员状态、一张**打包内置**的付款二维码（微信扫码）和「刷新状态」按钮的窗口。插件内不发生任何支付行为，自动后台同步也不会出现这行提醒。

**没有自更新。** 本构建**不含任何自更新机制**，更新只通过 Obsidian 官方社区插件目录分发。手动同步后，若市场上有新版本，同步状态提示下方可能出现一行弱提醒（仅从 `obsidian.notebooksyncer.com/plugversion-market` 获取一个版本号）；点击后打开 Obsidian **设置 → 第三方插件** 页面，由你自行决定是否升级。插件永远不会下载或替换自身文件。

**静态推广（已披露）。** 设置页会展示会员状态和一张**打包内置**的付费会员购买二维码；上面说的续费窗口用的是另一张打包内置的付款二维码。两张图都编译进插件包，展示时**零网络请求**。服务端拼进笔记正文的推广二维码会在写入仓库前被插件**剥除**——不会有任何推广内容写进你的笔记。

**无跨插件脚本行为。** 本版本不调用其它插件的命令，也不执行 Templater 插值；模板里的 `<% %>` 标签会原样保留。作为安全防护，本插件创建的文件会被标记，避免已安装的 Templater 插件执行同步网页内容中出现的模板命令。

### 安装与快速上手

1. 安装并启用插件；
2. 关注微信服务号「笔记同步助手」，获取 API 密钥，填入插件设置；
3. 点击侧边栏图标（或运行 `Sync` 命令），同步的笔记落在设置中配置的文件夹（默认 `Synced/`）；
4. 可选：在设置页自定义模板（前置元数据、文件命名、合并模式）、图片/附件本地化、日记双链与同步频率。

文件夹与文件名设置提供目录选择、模板变量插入和路径示例。快捷设置会先展示变更，应用后可在本次设置页会话内撤销，已有文件不移动。邮件笔记与单条消息可以分别设置文件夹、文件名、前置元数据和正文模板，每个留空字段使用对应的文章设置；双写时的合并副本继续使用合并设置。

开启本地化后，笔记先保存，图片和附件继续下载；同步完成提示会注明仍有后台处理。下载暂时失败时保留远程链接，Obsidian 运行期间按退避间隔重试，回到前台继续到期任务。也可通过笔记右键菜单立即重新本地化。历史版本已发生的同名附件错链无法自动识别或修复。 移动端附件本地化需要 Obsidian 1.12.3 或更高版本，且下载来源允许浏览器跨域访问。附件分块写入以控制内存；宿主版本或来源不支持时保留远程链接及重试待办。

### 隐私与数据位置

- 设置（含 API 密钥）保存在仓库内 `.obsidian/plugins/wechat-note-helper/data.json`；
- 下载的图片/附件保存在你配置的附件文件夹；
- 你分享给服务号的内容保存在服务端，直到你删除（设置页提供「清空云端内容」操作）。

### 模板变量

见 [TEMPLATE-VARIABLES.md](TEMPLATE-VARIABLES.md)。

### 许可证

[MIT](LICENSE.md)
