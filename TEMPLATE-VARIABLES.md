# 可用模板变量 / Available Template Variables

本文档列出了笔记同步助手插件中所有可在模板中使用的变量。

## 📅 日期时间变量 / Date & Time Variables

### 保存时间 / Saved

- `{{{dateSaved}}}` - 保存时间（按"文章文件夹日期格式"渲染）/ Saved date (full format)
- `{{{date}}}` - `{{{dateSaved}}}` 的别名 / alias of dateSaved
- `{{{timeSaved}}}` - 保存时刻的时间部分（本地时区 `HH:mm:ss`，不受日期格式设置影响；按天分文件的日记只想要时间时用）/ Time of day saved (HH:mm:ss)
- `{{{timeSavedShort}}}` - 保存时刻的时间部分（`HH:mm`）/ Time of day saved (HH:mm)
- `{{{yearSaved}}}` - 保存日期的年份（4 位）/ Year of saved date (4-digit)
- `{{{monthSaved}}}` - 保存日期的月份（2 位补零）/ Month of saved date (2-digit, zero-padded)
- `{{{daySaved}}}` - 保存日期的日（2 位补零）/ Day of saved date (2-digit, zero-padded)

### 发布时间 / Published（文章有 publishedAt 字段时可用）

- `{{{datePublished}}}` - 发布时间
- `{{{yearPublished}}}` / `{{{monthPublished}}}` / `{{{dayPublished}}}` - 发布日期年/月/日
- ⚠️ publishedAt 缺失时这几个变量渲染为空串

### 阅读时间 / Read（文章有 readAt 字段时可用）

- `{{{dateRead}}}`
- `{{{yearRead}}}` / `{{{monthRead}}}` / `{{{dayRead}}}`

### 归档时间 / Archived（文章 isArchived=true 时可用）

- `{{{dateArchived}}}` - 归档时间
  - ⚠️ 在文件夹 / 文件名模板里：按"文章文件夹日期格式"渲染
  - ⚠️ 在正文 / 前置元数据模板里：渲染为原始 ISO 串（方便下游工具解析）
- `{{{yearArchived}}}` / `{{{monthArchived}}}` / `{{{dayArchived}}}`

### 更新时间 / Updated

- `{{{updatedAt}}}` - 仅正文 / 前置元数据模板可用，始终是原始 ISO 串
- `{{{yearUpdated}}}` / `{{{monthUpdated}}}` / `{{{dayUpdated}}}` - 所有模板都可用

> 📝 所有 `year*/month*/day*` 拆解变量都基于**本地时区**从 ISO 时间戳解出，始终两位补零（月份、日）或四位年。不受"文章文件夹日期格式"设置影响 —— 这样写 `{{{yearSaved}}}/{{{monthSaved}}}` 拼文件夹路径时，不用再额外配日期格式。

## 📄 文章基本信息 / Article Basic Info

- `{{{id}}}` - 文章ID / Article ID
- `{{{title}}}` - 文章标题；开启「消息单独设置」的单篇消息使用去掉日期与类型前后缀的标题 / Article title, or clean standalone message title
- `{{{rawTitle}}}` - 原始标题，所有模式可用 / Original title
- `{{{messageTitle}}}` - 消息干净标题，非消息为原始标题 / Clean message title, original title for articles
- `{{{messageType}}}` - 文本、图片、视频、语音、文件、聊天记录、笔记、媒体；非消息或未知类型为空 / Message type, empty for articles or unknown suffixes
- `{{{author}}}` - 作者 / Author
- `{{{siteName}}}` - 网站名称 / Website name
- `{{{originalUrl}}}` - 原文链接 / Original URL

## 📝 内容与元数据 / Content & Metadata

- `{{{content}}}` - 文章内容 / Article content
- `{{{labels}}}` - 标签 / Labels
- `{{{type}}}` - 内容类型 / Content type (ARTICLE, FILE, etc.)
- `{{{state}}}` - 状态 / State (INBOX, READING, COMPLETED, ARCHIVED)
- `{{{wordsCount}}}` - 字数 / Word count

## 🔧 自定义函数 / Custom Functions

- `{{#lowerCase}}text{{/lowerCase}}` - 转小写 / Convert to lowercase
- `{{#upperCase}}text{{/upperCase}}` - 转大写 / Convert to uppercase
- `{{#upperCaseFirst}}text{{/upperCaseFirst}}` - 首字母大写 / Capitalize first letter
- `{{#formatDate}}dateSaved, yyyy-MM-dd{{/formatDate}}` - 自定义日期格式 / Custom date format
- `{{#mapValue}}取值\|规则表{{/mapValue}}` - 值映射 / Map a value by rules
- `{{#extract}}取值\|匹配规则\|输出格式{{/extract}}` - 抠取片段 / Extract a part of a value
- `{{#oneLine}}取值{{/oneLine}}` - 多行折成一行（换行 → `<br>`），流式笔记插件（Memos / Thino）只认单行列表项时用 / Fold a multi-line value into one line

### mapValue 值映射 / Value mapping

把某个变量的值按规则映射成另一个值，常用于把平台名转成业务分类（例如属性
`type` 写「视频转图文 / 播客整理」）。语法：

```
{{#mapValue}}<取值表达式>|<规则表>{{/mapValue}}
```

- `<取值表达式>` 先按模板渲染（可写 `{{{siteName}}}` 等），渲染后首尾空白被裁剪。
- `<规则表>` 是逗号分隔的 `pattern=result`：
  - 精确：`抖音=视频转图文` —— 取值完全等于「抖音」时命中
  - 通配：`*播客*=播客整理` —— 取值**含**「播客」时命中（contains）
  - 兜底：`*=其他` —— 上面都不命中时用它
- 命中优先级（与书写顺序无关）：**精确 > 通配 > 兜底 > 原值**（无规则命中且无兜底 → 原样返回取值）。

示例（属性/前置元数据模板里）：

```
type: {{#mapValue}}{{{siteName}}}|抖音=视频转图文,快手=视频转图文,*播客*=播客整理,*=其他{{/mapValue}}
```

- `siteName=抖音` → `视频转图文`
- `siteName=小宇宙播客` → `播客整理`（命中 `*播客*`）
- `siteName=知乎` → `其他`（命中兜底）

> 局限：`pattern` 不能含 `=`；`pattern`/`result` 不能含 `,`（都是分隔符）；通配仅支持
> `*xxx*` 两端星号的 contains，不支持前缀/后缀/正则。取值表达式渲染后可安全包含 `|`。

### extract 抠取片段 / Extract

从某个变量里**抠出想要的那一段**（Mustache 本身没有截取能力）。最常见的用法是
关掉「合并」之后，让每条企微消息的文件名只保留正文摘要——消息标题固定形如
`同步助手_20260824_空调蓝图打印 #丰顺展厅_文本`，前面的「同步助手_日期_」和后面的
「_类型」都不想要。语法：

```
{{#extract}}<取值表达式>|<匹配规则>|<输出格式>{{/extract}}
```

- `<取值表达式>` 先按模板渲染（可写 `{{{title}}}` 等），渲染后首尾空白被裁剪。
- `<匹配规则>` 按字面量使用（不再过模板），写法就是常规的匹配表达式；里面要用竖线
  时写成 `\|`（否则会被当成参数分隔符）。规则的首尾空格会被裁掉，要匹配空格请写 `\s` 或 `[ ]`。
- `<输出格式>` 可省略，默认 `$1`（第 1 个括号里的内容；规则里没有括号时取整段命中）。
  支持 `$1`~`$9`、`$&`（整段命中）、`$$`（一个字面 `$`）。

**安全兜底**：下面几种情况一律**原样返回取值**，绝不返回空——文件名模板走的就是这条路，
抠空了整篇笔记会落到「未命名」上，比不抠更糟：

- 规则没命中（例如普通文章标题根本没有那套前后缀）
- 规则本身写错
- 只给了取值、没给规则
- 抠出来是空白（`^` / `a*` 这种能匹配空串的规则也算）
- 取值超过 1 万字符（写错的规则可能在长文本上死循环，宁可不抠也不能把同步挂死；
  会在控制台留一条错误日志）

示例（「文章文件名」里，配合「消息处理 → 合并方式 = 不合并」）：

```
{{#extract}}{{{title}}}|^同步助手_\d{8}_([\s\S]+)_[^_]+$|$1{{/extract}}
```

| 标题 | 文件名 |
|---|---|
| `同步助手_20260824_空调蓝图打印 #丰顺展厅_文本` | `空调蓝图打印 #丰顺展厅` |
| `同步助手_20260824_聊天记录_聊天记录` | `聊天记录` |
| `同步助手_20260824_图片_图片` | `图片` |
| `SuMore — 创意无限 探索无界`（普通文章） | `SuMore — 创意无限 探索无界`（原样） |

> `[\s\S]` 是「任意字符（含换行）」——转发的聊天片段标题里会带换行，用它才抠得到。
> 抠完同名的消息（多条「聊天记录」）不会互相覆盖，插件会自动写成 `聊天记录 2`、`聊天记录 3`。

## 🔗 Templater 标签 / Templater Tags

市场版不执行 Templater 插值，也不调用其它插件的命令。模板中的 `<% %>` 标签原样保留；
同步创建文件时保留触发抑制护栏，避免网页正文里的模板命令被自动执行。
每条消息的时间请使用 `{{{dateSaved}}}` 或 `{{{timeSavedShort}}}`。

The marketplace build preserves `<% %>` tags as text and does not invoke Templater interpolation or other plugins' commands. A creation-time guard prevents automatic execution of template commands embedded in synced content.

## 💡 使用示例 / Examples

### oneLine 折成一行 / Fold into one line

```
- {{{timeSavedShort}}} {{#oneLine}}{{{content}}}{{/oneLine}}
```

把取值里的每一段换行（含空行与两侧空白）换成一个 `<br>`，首尾空白去掉。
用途：Memos / Thino 这类「流式笔记」插件只把日记里 `- 时:分 正文` 这种**单行**列表项当一条，
多选转发的聊天记录有多行时只有第一行进得了列表；折成一行后整条都能读到，Thino 会把 `<br>` 还原成换行显示，
Obsidian 阅读视图也照常换行。真机对照见 `tests/real-obsidian/docs/memos-thino-compat.md`。

### 文件名示例 / Filename Examples

```
{{{yearSaved}}}-{{{monthSaved}}}-{{{daySaved}}}-{{{title}}}
```
结果：2025-01-23-文章标题

### 文件夹示例 / Folder Examples

```
{{{yearSaved}}}/{{{monthSaved}}}
```
结果：2025/01

### 自定义日期格式 / Custom Date Format

```
{{#formatDate}}dateSaved, yyyy年MM月dd日{{/formatDate}}
```
结果：2025年01月23日

## 应用场景 / Use Cases

### 1. 文件夹路径 (Folder Path)
可在"文件夹"设置中使用这些变量来动态组织文件结构。

### 2. 文件名 (Filename)
可在"文件名"设置中使用这些变量来自动命名文件。

### 3. 文章模板 (Article Template)
可在"文章模板"设置中使用这些变量来自定义文章内容的显示格式。

### 4. 前置元数据模板 (Front Matter Template)
可在"前置元数据模板"设置中使用这些变量来自定义 YAML 格式的元数据。

### 5. 助手消息模板 (Assistant Message Template)
可在"助手消息模板"设置中使用这些变量来自定义企微消息的显示格式。

可用变量：`{{{content}}}`（消息内容）、`{{{heading}}}`（内容摘要，日记链接锚点用）、
`{{{title}}}`、`{{{id}}}`、`{{{savedAt}}}`，以及上面的整套保存日期变量
（`{{{dateSaved}}}` / `{{{date}}}` / `{{{timeSaved}}}` / `{{{timeSavedShort}}}` /
`{{{yearSaved}}}` …）。**内置函数同样可用**：例如
`{{#formatDate}}{{dateSaved}},HH:mm{{/formatDate}}` 只显示时分；标题行里用了函数或
`{{{timeSaved}}}` 时，日记链接的锚点会按同一套规则渲染，与文件里的标题保持一致。

按天分文件的日记场景，只想显示时间 + 内容：

```
{{{timeSaved}}}
{{{content}}}
```

### 6. 合并文件模板 (Merged File Template)
可在"合并文件模板"设置中自定义**合并消息文件的文件头**（新建那一刻写进去的：笔记属性 /
标题 / 说明）。留空 = 保持历史行为（创建空文件，只有消息）。

> ⚠️ 这个模板的变量集与上面几处**不同**（它渲染的是"文件"而不是"某一篇内容"），
> 只有以下两个：

| 变量 | 含义 |
|------|------|
| `{{{date}}}` | 该合并文件的日期，按"消息文件日期格式"渲染（与文件名里的 `{{{date}}}` 同值） |
| `{{{title}}}` | 该合并文件的文件名（不含 `.md`） |

示例：

```
---
tags: [消息]
---

# 📮 {{{date}}} 的消息
```

说明：

- **不会往笔记里写任何隐藏标记 / 锚点。** 插件靠"由模板反推出来的正则"在正文开头认出
  文件头（模板里的变量位置是通配符，所以日期换了也认得），把新消息插在它下面。
- 按时间**降序**（默认）时新消息紧跟在文件头之下；**升序**时追加到文件末尾。
- 你**手动改过文件头**之后插件就认不出了，此时新消息回到文件最前面 —— 只是排版退回旧样子，
  绝不会改动或删除你已有的任何内容。
- 只影响**新建**的合并文件；已经存在的文件不会被改写。
- 模板**第一行的 `---` 会被 Obsidian 当作属性块起始**。想画分割线请挪到第二行之后；
  设置页会实时红字提示。

## 注意事项 / Notes

1. 使用三个大括号 `{{{variable}}}` 表示不转义 HTML
2. 使用两个大括号 `{{variable}}` 表示转义 HTML
3. 日期格式遵循标准的日期格式化规范
4. 自定义函数可以嵌套使用

---

更多信息请关注《笔记同步助手》服务号。

## 设置页路径控件 / Path Controls

文件夹右侧的文件夹按钮可选择已有目录或输入新目录；选中后替换整个字段，目录在同步时创建。
变量按钮把所选变量追加为一级子目录；文件名变量在光标处插入，可替换选区。下方示例使用最近一篇笔记的数据和对应日期格式，并应用实际路径的字符清洗规则。

「路径设置 → 快捷设置」提供不按日期分文件夹、按平台分文件夹、消息每条单独一篇、恢复默认路径。确认前逐项显示差异，应用后可在本次设置页会话内撤销；已有文件不移动。

「消息单独设置」默认关闭，在不合并或双写时可开启。文件夹、文件名、两项日期格式、笔记属性及正文模板分别留空时使用文章对应值。双写的合并副本继续使用原合并模板。同名消息按现有规则编号。

Folder pickers replace the whole folder field; variable buttons append a folder segment or insert a file-name variable at the selection. Previews use a recent note and the same path sanitization as sync. Presets show a confirmation diff and support undo during the current settings session. They do not move existing files. Standalone-message settings default to off; blank fields inherit article settings, while the merged copy in dual-write mode retains its merge template.
