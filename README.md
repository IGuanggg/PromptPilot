# PromptPilot

<p align="center">
  <img src="docs/assets/preview.png" alt="PromptPilot preview" width="70%" />
</p>

PromptPilot 是一个 Chrome / Edge Manifest V3 浏览器插件，用于把网页图片反推成结构化 AI 绘图提示词，并在同一侧边栏中继续完成图片生成、多角度参考图生成、历史管理和接口调试。

## 核心功能

- **网页图片一键反推**：在网页图片上右键即可发送到插件侧边栏，自动展示图片并调用 Vision / Prompt API 生成中文 Prompt、英文 Prompt 和 tags。
- **提示词编辑与优化**：保留内置反推模板，支持额外要求、自定义补充提示词，以及中文 / 英文提示词二次优化。
- **图片生成闭环**：基于反推结果继续调用 Image API 出图，支持单张下载、批量下载、输出比例和分辨率配置。
- **多角度参考图生成**：围绕同一主体生成参考角度、侧面、背面和顶面视角，适合角色设定、产品参考和素材拆解。
- **历史与草稿恢复**：自动保存本地草稿，支持历史记录恢复、搜索、删除、导出和导入，方便反复对比不同提示词和结果。
- **接口状态与调试**：顶部显示 Prompt API / Image API 连接状态，内置调试日志、最近一次 API 调用、错误卡片和失败原因提示。
- **灵活 Provider 配置**：支持 OpenAI-compatible 接口和 DIY Custom API，可配置请求模板、响应映射、鉴权方式、尺寸格式和 Mock fallback。

## 技术栈

- Chrome Manifest V3
- 原生 HTML / CSS / JavaScript
- 不依赖 React、Vite、Webpack
- 使用 `chrome.storage.local` 保存设置、草稿和历史
- 使用 `chrome.contextMenus` 处理图片右键菜单
- 使用 `chrome.downloads` 下载生成结果

## 已支持的接口

### Prompt / Vision

- OpenAI-compatible Chat / Vision
- DIY Custom Prompt API
- Mock fallback

### Image Generation

- OpenAI-compatible Image API
- DIY Custom Image API
- Mock fallback，未配置真实 API 时仍可生成 4 张占位图跑通流程

## 安装方式

1. 打开 Chrome 或 Edge
2. 进入 `chrome://extensions`
3. 打开「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择项目里的 `extension/` 目录
6. 在网页图片上右键，选择「图片转提示词」

## 使用流程

1. 右键网页图片，选择「图片转提示词」
2. 在 PromptPilot 窗口中确认图片预览
3. 可选填写「额外要求」
4. 点击「反推」
5. 查看并编辑中文 Prompt、英文 Prompt 和 tags
6. 点击「生成图片」或「生成多角度」
7. 下载单张结果或下载全部结果
8. 可在「历史」中恢复之前的图片、Prompt 和生成结果

## 设置说明

### Prompt API

在设置页填写：

- Base URL
- Endpoint
- API Key
- Model
- Temperature
- Max Tokens
- 自定义补充提示词

「自定义补充提示词」不会替换内置反推模板，只会追加到内置模板后面，适合放长期偏好，例如：

```text
强化主体、场景、构图、镜头、光影、色彩、材质和细节描述。
输出更适合 AI 绘图模型使用的完整文生图 Prompt。
避免出现品牌名、水印、版权角色名称。
```

### Image API

在设置页填写：

- Base URL
- Endpoint
- API Key
- Model
- Response Format
- 输出尺寸模式

输出尺寸模式：

- 跟随参考图：根据参考图横竖自动选择 `16:9`、`9:16` 或 `1:1`
- 比例预设：手动选择 `1:1`、`4:3`、`3:4`、`16:9`、`9:16`
- 自定义尺寸：手动输入宽高

## 历史与本地存储

插件只使用本地存储，不做账号系统和云同步。

使用的主要 storage key：

- `settings`：插件设置
- `pendingImage`：右键图片后的待处理图片
- `promptpilotDraft`：当前工作草稿
- `promptpilotHistory`：历史记录

历史记录支持：

- 保存反推过的图片和 Prompt
- 保存生成结果
- 搜索和筛选
- 恢复到当前工作区
- 删除单条历史
- 清空历史
- 导出 / 导入 JSON

## 调试

插件内置调试面板，可以查看：

- 最近一次 API 调用
- 当前状态摘要
- 请求 / 响应日志
- 错误信息
- Provider、Endpoint、耗时、HTTP 状态码

敏感信息会脱敏：

- API Key 只显示前 4 位和后 4 位
- Authorization header 会被隐藏
- Base64 图片数据会被截断

## 目录结构

```text
image-prompt-extension/
├─ docs/
├─ extension/
│  ├─ manifest.json
│  ├─ assets/
│  └─ src/
│     ├─ background.js
│     ├─ contentScript.js
│     ├─ constants.js
│     ├─ adapters/
│     ├─ data/
│     ├─ options/
│     ├─ services/
│     ├─ sidepanel/
│     └─ utils/
└─ README.md
```

## 更新日志

### v0.2.0 — 双通道生图 & 模型能力系统 (2026-05)

**新增双通道图像生成架构：**

- **Image 通道**（gpt-image-2 / gpt-image-2-vip）：`POST /v1/draw/completions`，使用 `aspectRatio` + `quality`
- **Nano Banana 通道**（nano-banana-pro / nano-banana-2 / nano-banana-fast）：`POST /v1/draw/nano-banana`，使用 `aspectRatio` + `imageSize`
- 两个通道统一通过 `POST /v1/draw/result` 异步轮询获取结果

**模型能力系统：**
- 设置页新增模型能力卡片：展示接口组、积分消耗、提交/结果接口、支持尺寸、能力标签
- 清晰度下拉根据所选模型自动过滤（nano-banana-fast / gpt-image-2 仅支持 1K）
- Endpoint 根据模型自动切换，默认只读，可手动覆盖

**内容审核处理：**
- `output_moderation` → `IMAGE_MODERATION_FAILED`（图片生成被安全审核拦截）
- `input_moderation` → `IMAGE_INPUT_MODERATION_FAILED`（提示词触发输入审核）
- 新增安全净化提示词功能

**Bug 修复：**
- 修复 AbortError 被误判为 `code: 20` 的问题
- 修复 JSON 响应被误当成 SSE 流解析
- 修复 Nano Banana `aspectRatio` / `imageSize` 为空的问题
- 修复"跟随参考图"模式对竖图的检测（9:16 不再被映射为 1:1 或 1:2）
- 修复 `webhook` 字段名大小写错误 → 统一为 `webHook: "-1"`
- 新增重复点击保护锁，防止一次点击触发多次生成

### v0.1.1 — 尺寸系统升级 (2026-04)

- 清晰度从 720p / 1080p 升级为 **1K / 2K / 4K**，覆盖 5 种比例共 15 个尺寸组合
- 新增 `detectStandardRatio`：跟随参考图模式映射到 5 个标准比例（1:1 / 16:9 / 9:16 / 4:3 / 3:4）
- Options 与 Side Panel 共享 `currentImageMeta`，统一尺寸计算
- 多角度生成使用统一 `getOutputSize()`
- 旧字段 `p720` / `p1080` / `quality` / `selectedRatio` 自动迁移

### v0.1.0 — MVP 首发 (2026-04)

- 右键图片 → Side Panel → Prompt 反推 → 生成图片闭环
- 支持上传、粘贴、拖拽图片，blob/防盗链自动转 dataURL
- Image API 生成：单图 + 多角度（参考/侧面/背面/顶面）
- 调试日志：API 请求/响应脱敏记录，尺寸映射日志
- 历史记录、草稿恢复、JSON 导出/导入
- 深色科技风 UI，青绿色主色调

## 隐私说明

- 插件不上传设置到云端
- 历史记录默认保存在本机浏览器 `chrome.storage.local`
- 导出历史不会包含 API Key
- 真实 API 请求只会发送到用户在设置页配置的接口地址
