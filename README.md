# NAI-IDLECLOUD

把 **NovelAI 官方 API** 请求转换为 **IDLECLOUD 通用生成端点**（`POST /api/generate_image`）的转换代理。
面向只支持 NovelAI 官方接口的客户端，使其无需改代码即可改用 IDLECLOUD 服务。

- API 文档参考：<https://nai.idlecloud.cc/api_docs.html>
- 上游基础地址：`https://api.idlecloud.cc`

---

## 一、它解决什么问题

NovelAI 官方客户端有两个固定预期：

1. **鉴权**：请求头必须是 `Authorization: Bearer <NovelAI token>`；
2. **返回格式**：`/ai/generate-image` 返回一个 **ZIP**（内含 PNG）。

而 IDLECLOUD 的通用端点是另一套契约：

1. 鉴权用的是 **IDLECLOUD API Key**；
2. 提交后返回 `{ "job_id": ..., "queue_position": ... }`，需要**轮询** `GET /api/get_result/{job_id}` 才能拿到 `image_url`；
3. 请求体是**扁平字段**（`positivePrompt` / `negativePrompt`），不是 NovelAI 的 `parameters` 嵌套结构。

本代理把这三处差异全部抹平。

---

## 二、请求转换对照

### 端点映射

| 客户端请求（NovelAI 契约） | 代理内部实际调用（IDLECLOUD） |
| :--- | :--- |
| `POST /ai/generate-image` | `POST /api/generate_image` → 轮询 `GET /api/get_result/{job_id}` |
| `POST /ai/augment-image` | 同上（图像工具：上色 / 情绪 / 线稿 / 草稿 / 清理） |
| `GET /user/subscription` | 本地构造（额度映射，见第六节） |
| `GET /user/information` | 本地构造（试用张数映射） |
| `POST /ai/upscale` | 返回 `501`（上游无此功能） |
| `POST /ai/generate-voice` | 返回 `501`（上游无此功能） |
| `POST /ai/generate`（文本补全） | 返回 `501`（上游只有 Grok 对话接口，语义不同，不做有损映射） |

### 字段映射

| NovelAI 字段 | IDLECLOUD 字段 | 说明 |
| :--- | :--- | :--- |
| `input` | `positivePrompt` | 若存在 `parameters.v4_prompt.caption.base_caption`，**后者优先** |
| `parameters.negative_prompt` | `negativePrompt` | 若存在 `v4_negative_prompt.caption.base_caption`，后者优先 |
| `parameters.width/height/steps/scale/sampler/noise_schedule/seed` | 同名扁平字段 | 直接透传 |
| `parameters.dynamic_thresholding` | `decrisp` | 名称不同 |
| `parameters.skip_cfg_above_sigma` | `variety` | 非空即视为启用 Variety |
| `parameters.cfg_rescale` | `promptGuidanceRescale` | 名称不同 |
| `parameters.image` | `image` + `action: true` | 自动去掉 `data:image/...;base64,` 前缀 |
| `parameters.mask` | `mask` + `inpaint_strength` | 触发局部重绘 |
| `parameters.reference_image_multiple[]` | 同名 | 逐项去 base64 前缀 |
| `parameters.director_reference_images[]` | `director_reference_images_cached[{data}]` | **需包装成对象**，裸数组上游不消费 |
| `parameters.characterPrompts[]` | 同名 | V5 模型自动补 `enabled: true` |
| `parameters.v4_prompt.caption.char_captions` | `v4_prompt_char_captions` | 角色控制 |
| `parameters.v4_negative_prompt.caption.char_captions` | `v4_negative_prompt_char_captions` | 角色控制 |

**不发送**的字段：`n_samples`、`params_version`、`ucPreset`、`qualityToggle`、`add_original_image`、`controlnet_strength`、`uncond_scale`、`v4_prompt`、`v4_negative_prompt` 等 NovelAI 专有结构——IDLECLOUD 通用端点不接受它们。

**空值处理**：`null`、`undefined`、空数组一律不发送（避免上游参数校验失败）；但**布尔 `false` 会显式保留**（`sm`/`sm_dyn`/`legacy` 等关闭状态必须传达）。

---

## 三、鉴权：这是本代理的核心

### 两种模式

| 模式 | 配置 | 行为 |
| :--- | :--- | :--- |
| **替换模式（推荐）** | 填写 `IDLECLOUD_API_KEY` | 忽略客户端传来的 token，一律用配置的 Key 访问上游。客户端里 API Key **随便填**。 |
| **透传模式** | `IDLECLOUD_API_KEY` 留空且 `AUTH_PASSTHROUGH=true` | 把客户端的 `Bearer <token>` 直接当作 IDLECLOUD API Key 使用。此时客户端必须填**真实的 IDLECLOUD Key**。 |

> 无论哪种模式，客户端**缺少** `Authorization` 头时，代理直接返回 `401`，不会触达上游。

### 上游错误如实上报

代理不会把上游的鉴权失败伪装成成功。Key 错误时：

```
客户端收到 HTTP 401  {"statusCode":401,"message":"提交任务失败: HTTP 401","code":"UPSTREAM_ERROR"}
```

---

## 四、返回格式：重新打包 ZIP

IDLECLOUD 通用端点返回的是**图片 URL**，而 NovelAI 客户端期望 **ZIP**。
代理下载图片后，用内置的 ZIP 打包器（STORE 方式，含正确 CRC-32）重新封装为 `image.zip`：

```
ZIP(image.png)  ←  从上游 image_url 下载的 PNG 字节
```

若上游返回的本身就是 ZIP（例如 `gemini-3-pro-image` 会返回 zip 地址），代理会**先解包取出 PNG**，再重新打包，避免出现「ZIP 套 ZIP」。

### NovelAI V5 私有交付

IDLECLOUD 的 V5 异步任务会额外返回 `v5_delivery` 元数据，要求客户端**下载后校验并确认**，否则文件会转入私有恢复区。代理自动完成全流程：

1. `GET /api/v5-results/{id}/file` 下载原图；
2. 比对 `size_bytes` 与 **SHA-256**；
3. `POST /api/v5-results/{id}/confirm` 发送 `{sha256, size_bytes}` 确认。

校验失败时**返回错误而不是坏图**，并且**不发送确认请求**（避免把损坏文件标记为已获取）。

---

## 五、限流：串行队列

IDLECLOUD 要求：

- API 请求间隔**至少 20 秒**；
- 并发任务限制为**每用户 1 个**。

代理内置串行队列，自动排队与节流，客户端可以随意并发提交而不会触发上游限流。

---

## 六、额度映射（NovelAI 字段 ← IDLECLOUD 额度）

### 为什么需要自己统计

IDLECLOUD 的 `GET /api/user_info` **只支持 Session 认证**，用 Bearer API Key 读不到额度
（实测返回 `ACCOUNT_AUTH_REQUIRED`）。因此代理以「经过本代理的成功生成」为口径统计，
并在上游返回 `NOVELAI_V5_WEEKLY_QUOTA_EXCEEDED` 时，用其权威的 `limit` / `remaining` / `reset_at`
校正本地计数。状态默认持久化到 `/data/quota.json`。

### 映射规则

| NovelAI 字段 | 承载的 IDLECLOUD 额度 |
| :--- | :--- |
| `trainingStepsLeft.fixedTrainingStepsLeft` | **每日生图请求次数**（默认返回「剩余」，可用 `DAILY_VALUE_MODE=used` 改为「已用」） |
| `usage.percent`（V5 充能 / Opus 生成额度） | **每周 V5 剩余次数**，剩余 67 次即返回 `67` |
| `usage.isNegative` | 每周额度是否用尽 |
| `usage.timeUntilNextPercent` | 距每周额度重置的秒数 |
| `/user/information` 的 `trialImagesLeft` | 每日剩余次数（与订阅端点显示一致） |

`usage.percent` 的语义与官方一致：它是**剩余量**，不是已用量
（官方文案 "N% of Opus Generations remaining"）。

### 实际输出示例

每日上限 600、已用 183；每周 V5 上限 100、已用 33 时：

```json
{
  "tier": 3,
  "active": true,
  "expiresAt": 1822193849,
  "trainingStepsLeft": { "fixedTrainingStepsLeft": 417, "purchasedTrainingSteps": 0 },
  "usage": { "percent": 67, "isNegative": false, "timeUntilNextPercent": 558150 },
  "perks": { "unlimitedImageGeneration": false },
  "idlecloud": {
    "daily": { "used": 183, "limit": 600, "remaining": 417 },
    "v5_weekly": { "used": 33, "limit": 100, "remaining": 67, "percent": 67 }
  }
}
```

`trainingStepsLeft` = 417（每日剩余次数），`usage.percent` = 67（每周 V5 剩余次数）。

### 计数规则

- **只有成功生成才计数**：上游失败或超时不扣减；
- **大图不计数**：宽高乘积 > 1048576、步数 > 28，或显式 `use_upscale_credits` 的请求走大图点数，
  既不占每日次数，也不计入 V5 周额度；
- **非 V5 模型不扣 V5 充能**：只有 `nai-diffusion-5-*` 消耗每周额度；
- **周期重置**：每日额度按北京时间（UTC+8）零点重置；每周额度按首次计入额度的 V5 生成起算的连续 7 天。

---

## 七、部署

### 使用预构建镜像

```bash
docker run -d --name nai-idlecloud-proxy --restart unless-stopped \
  -p 8788:8788 \
  -v /path/to/data:/data \
  -e IDLECLOUD_API_KEY=<你的IDLECLOUD Key> \
  ghcr.io/wlgh01/nai-idlecloud-proxy:latest
```

### 本地构建

```bash
docker build -t nai-idlecloud-proxy:latest .
```

镜像由 GitHub Actions 在推送到 `main` 或打 `v*` tag 时自动构建并推送到 GHCR。

---

## 八、环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `8788` | 容器内监听端口 |
| `IDLECLOUD_BASE_URL` | `https://api.idlecloud.cc` | 上游基础地址，**不带** `/api` 后缀 |
| `IDLECLOUD_API_KEY` | 空 | IDLECLOUD API Key。填写后进入替换模式（推荐） |
| `AUTH_PASSTHROUGH` | `true` | 未配置 Key 时是否透传客户端 Bearer |
| `MIN_INTERVAL_MS` | `20000` | 向上游提交的最小间隔。**不建议低于 20000** |
| `MAX_CONCURRENCY` | `1` | 并发数。**上游限制为 1** |
| `POLL_INTERVAL_MS` | `5000` | 轮询结果间隔 |
| `REQUEST_TIMEOUT_MS` | `900000` | 单任务总超时（15 分钟） |
| `AUGMENT_MODEL` | `nai-diffusion-4-5-full` | 图像工具端点的兜底模型 |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug` |
| `QUOTA_FILE` | `/data/quota.json` | 额度状态文件；设为空字符串则仅内存统计 |
| `DAILY_LIMIT` | `600` | 每日生图请求次数上限 |
| `V5_WEEKLY_LIMIT` | `100` | 每周 V5 图片额度上限 |
| `DAILY_VALUE_MODE` | `remaining` | 训练步数字段填 `remaining`（剩余）或 `used`（已用） |
| `V5_PERCENT_MODE` | `count` | `count` = 剩余次数直接当百分比；`ratio` = 剩余/上限×100 |
| `NAI_TIER` | `3` | 返回给客户端的订阅档位（3 = Opus，才会显示 V5 充能条） |
| `NORMAL_STEPS_LIMIT` | `28` | 普通模式步数上限，超过视为大图 |

---

## 九、客户端接入

代理对外暴露的是 NovelAI 官方路径（`/ai/generate-image`、`/user/subscription` 等），
因此客户端只需把 NovelAI 的 Base URL 指向本代理即可。

注意：部分客户端（如 SillyTavern）后端把 NovelAI 地址**硬编码**为 `image.novelai.net`，
此时需用 `extra_hosts` 或本地 DNS 把该域名指向本代理，或改用支持自定义 Base URL 的客户端。

### 直接验证

```bash
# 健康检查（含额度快照）
curl http://<host>:8788/healthz

# 生成（返回 ZIP）
curl -X POST http://<host>:8788/ai/generate-image \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <IDLECLOUD API Key>" \
  -d '{"action":"generate","input":"1girl, solo","model":"nai-diffusion-4-5-full",
       "parameters":{"width":832,"height":1216,"scale":5,"steps":28,
       "sampler":"k_euler","noise_schedule":"karras","negative_prompt":"lowres","n_samples":1}}' \
  -o out.zip
```

---

## 十、测试

```bash
# 单元 + 集成测试（86 项，含 mock 上游的完整链路）
node --test

# 反向验证：故意破坏实现，确认测试会变红
node scripts/mutation.mjs

# 真实上游冒烟（不消耗额度）
node scripts/smoke.mjs
```

---

## 十一、已知限制

- **请求间隔 20 秒**是上游硬性要求，出图速度受此约束；
- 上游**不提供**放大（upscale）、语音（voice）与文本补全，相关端点返回 `501` 并说明原因；
- 上游 V5 有**每周图片额度**（按订阅档位），超额返回 `429`，代理会如实透传；
- 休眠时段（UTC+8 04:00–07:00）上游不可用；
- 单次请求上游最多等待约 600 秒，超时返回 `504`。
