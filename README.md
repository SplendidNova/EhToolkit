# EH Toolkit - E-Hentai / ExHentai 浏览器辅助插件 (Manifest V3)

适用于 **Windows / macOS / Linux** 上的 Chrome、Edge 及 Chromium 内核浏览器的 Manifest V3 扩展程序，集成了 **ExHentai 里站 Cookie 同步与管理**、收藏夹跨账号迁移、标签去重与自定义重点标签统计、外部链接自动跳转镜像站/表里站目标域名转换、以及快捷键复制转换画廊链接域名功能。所有功能与运行参数均已分离至 `settings.json`，并支持独立开关控制。

## 核心功能

1. **10 个收藏夹跨账号迁移（功能 1）**
   - 读取当前账号 `favcat=0` ~ `favcat=9` 共 10 个收藏夹的所有画廊及 `favnote` 备注（支持游标分页 `#unext` 与传统分页，兼容 Minimal / Compact / Extended / Thumbnail 全部视图）。
   - 支持本地持久化缓存与导出/导入 `.json` 备份文件。
   - 切换登录新账号后，按对应的 `0~9` 收藏夹序号一键导入，默认采用倒序导入以保持原排序，并支持断点续传、暂停/继续与失败重试。

2. **收藏夹标签提取与去重统计（功能 2）**
   - 自动去重收集收藏夹内画廊，默认按每批 25 个调用 E-Hentai `api.php` (`gdata`, `namespace: 1`) 获取元数据；当镜像站未代理 `api.php` 时自动回退到官方 `https://api.e-hentai.org/api.php`。
   - 不重复列出所有 `artist`、`group`、`parody` 列表，并统计各自对应的画廊数量，支持搜索、排序与点击查看关联画廊。
   - 支持单独统计自定义重点标签（可在 `settings.json` 的 `tagStats.highlightTags` 中自由配置）的画廊数量、占比与命中明细，支持一键复制文本汇总或导出 JSON / CSV。

3. **外部打开链接自动转镜像站（功能 3）**
   - 从外部软件（如 QQ / Telegram / Discord 等）点击 `exhentai.org` 或 `e-hentai.org` 链接拉起默认浏览器打开时，自动跳转到 `settings.json` 或界面中配置的自定义镜像域名，并保留完整画廊路径。
   - 插件会基于 `chrome.scripting` 自动为配置的镜像域名动态注入内容脚本，无需手动修改 `manifest.json`。

4. **快捷键复制转换域名 & 外链表里站目标域名转换（功能 4）**
   - **快捷键复制换域名（默认总是输出 `exhentai.org`）**：支持「总是转为 `exhentai.org`」、「总是转为 `e-hentai.org`」或「双向互转」。按下快捷键（默认 `Alt + C`）即可将转换后链接写入剪贴板。
   - **外链表里站目标域名转换（默认总是使用 `exhentai.org`）**：支持单向固定目标域名或双向互转（双向模式下通过「仅外部/新入口触发」防止站内点击反复翻转）。

5. **ExHentai 里站 Cookie 管理与里站限定画廊通行（新增）**
   - **表里站自动同步与防白屏**：自动（或一键）将 `e-hentai.org` 已登录的 `ipb_member_id`、`ipb_pass_hash`、`igneous`、`sk` 同步至 `.exhentai.org`，并自动清理触发白屏的 `yay` 与无效 `igneous=mystery` 缓存。
   - **手动导入 / 粘贴配置**：支持直接粘贴整段 Cookie 字符串、DevTools 复制行或 JSON 自动识别填入；针对使用日本/共享代理节点需要固定 `igneous` 通行证的场景，可持久保存并一键写入浏览器。
   - **表站不可见画廊自动跳里站**：打开 `e-hentai.org` 上的里站限定画廊遇到 *"This gallery has been removed or is unavailable."* 时，自动确保 Cookie 就绪并跳转至 `exhentai.org`（或配置的镜像站）查看。
   - **全链路带 Cookie 请求**：收藏夹跨账号读取/导入、以及标签统计 `exhentai.org/api.php` 调用均自动携带里站 Cookie，防止漏读里站限定画廊或元数据缺失。

## 配置文件说明 (`settings.json`)

项目将所有自定义参数集中管理在根目录的 `settings.json` 中（仓库提供脱敏模板 `settings.example.json`，`settings.json` 已加入 `.gitignore` 防止个人镜像站域名泄露）：

- **首次克隆仓库后**：可将 `settings.example.json` 复制为 `settings.json` 并按需修改（若未创建 `settings.json`，插件会自动回退读取 `settings.example.json`）：
  ```bash
  cp settings.example.json settings.json
  ```
- **热重载与导出**：
  - 直接编辑本地 `settings.json` 后，可在插件「控制台 → 3. 跳转与全局参数设置」点击 **「从 settings.json 重新加载」** 立即生效；
  - 在弹窗或控制台界面修改任意参数后，也可点击 **「导出当前配置为 settings.json」** 下载覆盖本地配置文件。

### `settings.json` 参数分组概览

| 分组 | 主要参数 | 说明 |
| :--- | :--- | :--- |
| `features` | `enableFavTransfer`, `enableTagStats`, `enableMirrorRedirect`, `enableShortcutCopy`, `enableDomainSwapRedirect` | 五大核心子功能的独立默认开关 |
| `redirect` | `mirrorDomain`, `mirrorSourceScope`, `domainSwapRedirectMode`, `redirectPriority`, `redirectExternalOnly`, `redirectDedupWindowMs` | 镜像站域名、表里站转换策略、优先级与重定向防重窗口 |
| `shortcutCopy` | `copyTargetDomain`, `mirrorCopyTarget`, `customShortcut`, `copyDedupWindowMs`, `toastDurationMs`, `toastErrorDurationMs`, `badgeClearDelayMs` | 页面快捷键组合、复制目标域名、提示横幅与扩展角标停留时长 |
| `favorites` | `defaultActiveSite`, `readDelayMs`, `readDelayMinMs`, `importDelayMs`, `importDelayMinMs`, `importReverseOrder`, `importSkipExisting`, `importSaveEveryN`, `favPreviewLimit` | 默认操作站点、收藏夹读取/导入请求间隔、倒序与断点续传策略、预览条数上限 |
| `tagStats` | `officialApiUrl`, `apiBatchSize`, `tagDelayMs`, `tagDelayMinMs`, `tagCooldownEveryBatches`, `tagCooldownExtraMs`, `highlightTags`, `highlightTagLabel` | 官方 API 地址、每批查询数量、防风控批次冷却参数、自定义重点统计标签及显示名称 |
| `cookies` | `enableExCookieManager`, `autoSyncEhToExCookie`, `syncCookieToMirror`, `preferExhentaiApi`, `autoRedirectUnavailableToEx`, `exCookieMemberId`, `exCookiePassHash`, `exCookieIgneous`, `exCookieSk` | ExHentai 里站 Cookie 自动同步、手动通行证配置、镜像站透传、里站 API 优先策略与表站不可见自动跳转 |
| `tester` | `sampleGalleryPath` | 控制台实时 URL 测试器的示例画廊路径 |

> **注**：仅浏览器地址栏焦点下的「浏览器级全局快捷键初始建议值 (`Alt+C`)」受限于 Manifest V3 规范需静态声明在 `manifest.json` 的 `commands` 字段中，安装后可在 `chrome://extensions/shortcuts` 中自由修改。

## 安装步骤 (Chrome / Edge)

1. 打开浏览器扩展管理页面：
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
2. 打开右上角 **开发者模式 (Developer mode)**。
3. 点击 **加载已解压的扩展程序 (Load unpacked)**，选择本插件目录 `EhToolkit`。
4. （可选）如需在鼠标焦点位于浏览器地址栏时直接触发复制转换域名，请访问 `chrome://extensions/shortcuts`（Edge 为 `edge://extensions/shortcuts`）设置全局快捷键。
