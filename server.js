/**
 * NovelAI 官方 API -> IDLECLOUD 转换代理。
 *
 * 对外：伪装成 NovelAI 官方端点（api.novelai.net / image.novelai.net），
 *       让酒馆等客户端无需改动即可使用。
 * 对内：所有生成请求走 IDLECLOUD 通用生成端点 POST /api/generate_image（异步 job + 轮询），
 *       并把 NovelAI 的 Bearer Token 替换为 IDLECLOUD API Key。
 *
 * 零第三方依赖，仅使用 Node 标准库。
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    convertNaiToGeneral,
    convertAugmentToGeneral,
    createZip,
    parseMultipart,
} from './convert.js';
import {
    QuotaTracker,
    buildNovelSubscription,
    buildNovelInformation,
    isV5Model,
    isBigImageRequest,
    NORMAL_STEPS_LIMIT_DEFAULT,
} from './quota.js';

export const VERSION = '1.0.0';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** 读取内置图标，供容器模板的 Icon 指向本服务。 */
function loadIcon() {
    try {
        return readFileSync(join(MODULE_DIR, 'icon.png'));
    } catch {
        return null;
    }
}

const ICON_PNG = loadIcon();

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function envInt(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envBool(env, name, fallback) {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

/**
 * 读取以「秒」为单位的时间配置，内部统一换算成毫秒使用。
 *
 * 配置项对外一律用秒（更符合直觉，避免多写三个零），代码内部仍以毫秒计算。
 * 兼容旧的 `*_MS` 变量：新变量优先，旧变量作为回退，保证既有部署升级后行为不变。
 *
 * @param {Record<string,string|undefined>} env
 * @param {string} name 秒制变量名，如 `MIN_INTERVAL`
 * @param {number} fallbackSeconds 默认值（秒）
 * @returns {number} 毫秒
 */
function envSeconds(env, name, fallbackSeconds) {
    const raw = env[name];
    if (raw !== undefined && raw !== '') {
        const seconds = Number.parseFloat(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    }

    // 回退到旧的毫秒制变量
    const legacyRaw = env[`${name}_MS`];
    if (legacyRaw !== undefined && legacyRaw !== '') {
        const legacy = Number.parseInt(legacyRaw, 10);
        if (Number.isFinite(legacy) && legacy >= 0) return legacy;
    }

    return fallbackSeconds * 1000;
}

export function loadConfig(env = process.env, overrides = {}) {
    return {
        port: envInt(env, 'PORT', 8788),
        // IDLECLOUD 基础地址（不含 /api）
        baseUrl: (env.IDLECLOUD_BASE_URL || 'https://api.idlecloud.cc').replace(/\/+$/, ''),
        // IDLECLOUD API Key。设置后忽略客户端传来的 token（推荐）。
        apiKey: env.IDLECLOUD_API_KEY || '',
        // 未配置 apiKey 时，是否把客户端 Bearer 当作 IDLECLOUD API Key 直接透传
        authPassthrough: envBool(env, 'AUTH_PASSTHROUGH', true),
        // 轮询间隔（秒）/ 单任务总超时（秒）——对外用秒，内部转毫秒
        pollIntervalMs: envSeconds(env, 'POLL_INTERVAL', 5),
        requestTimeoutMs: envSeconds(env, 'REQUEST_TIMEOUT', 900),
        // 上游请求间隔（秒），默认 0 = 关闭（不节流）
        minIntervalMs: envSeconds(env, 'MIN_INTERVAL', 0),
        maxConcurrency: Math.max(1, envInt(env, 'MAX_CONCURRENCY', 1)),
        // 图像工具端点使用的兜底模型
        augmentModel: env.AUGMENT_MODEL || 'nai-diffusion-4-5-full',
        logLevel: env.LOG_LEVEL || 'info',

        // ---- 额度映射（NovelAI 字段 <- IDLECLOUD 额度）----
        // IDLECLOUD 的 /api/user_info 只认 Session，Bearer API Key 读不到额度，
        // 因此额度以「经过本代理的成功生成」为口径统计，并可持久化。
        quotaFile: env.QUOTA_FILE === '' ? null : (env.QUOTA_FILE || '/data/quota.json'),
        // 每日普通生成次数上限（文档：进阶档位 600 / 高级档位 800）
        dailyLimit: envInt(env, 'DAILY_LIMIT', 600),
        // 每周 V5 图片额度上限（文档：月档 ≥40 为 100）
        v5WeeklyLimit: envInt(env, 'V5_WEEKLY_LIMIT', 100),
        // 训练步数字段填「剩余」还是「已用」
        dailyValueMode: (env.DAILY_VALUE_MODE || 'remaining').toLowerCase() === 'used' ? 'used' : 'remaining',
        // V5 充能百分比口径：count = 剩余次数直接当百分比（剩余 67 次 -> 67）
        v5PercentMode: (env.V5_PERCENT_MODE || 'count').toLowerCase() === 'ratio' ? 'ratio' : 'count',
        // 返回给客户端的 NovelAI 订阅档位：3 = Opus（只有 Opus 才会显示 V5 充能条）
        tier: Math.min(3, Math.max(0, envInt(env, 'NAI_TIER', 3))),
        // 普通模式步数上限，超过即视为大图（不占每日次数与 V5 周额度）。默认 28。
        normalStepsLimit: envInt(env, 'NORMAL_STEPS_LIMIT', NORMAL_STEPS_LIMIT_DEFAULT),
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// 串行队列：并发数与提交间隔均可由启动项控制
//
// 关于间隔：IDLECLOUD 服务端确实会拒绝过于频繁的请求，原文为
//   HTTP 429 {"error":"API requests must be at least 20 seconds apart."}
// 但本队列天然是串行的——上一个任务（含提交与轮询）结束后才轮到下一个，
// 而一次生成通常远超 20 秒，因此间隔默认关闭（0）即可满足上游要求。
// 需要显式限速时，用 MIN_INTERVAL_MS 开启。
// ---------------------------------------------------------------------------

export class SerialQueue {
    constructor({ maxConcurrency, minIntervalMs }) {
        this.maxConcurrency = maxConcurrency;
        this.minIntervalMs = minIntervalMs;
        this.running = 0;
        this.queue = [];
        this.lastStart = 0;
    }

    run(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.#drain();
        });
    }

    #drain() {
        if (this.running >= this.maxConcurrency || this.queue.length === 0) return;
        // minIntervalMs <= 0 表示不节流
        if (this.minIntervalMs > 0) {
            const elapsed = Date.now() - this.lastStart;
            const wait = Math.max(0, this.minIntervalMs - elapsed);
            if (wait > 0) {
                setTimeout(() => this.#drain(), wait);
                return;
            }
        }
        const item = this.queue.shift();
        this.running += 1;
        this.lastStart = Date.now();
        Promise.resolve()
            .then(item.task)
            .then(item.resolve, item.reject)
            .finally(() => {
                this.running -= 1;
                this.#drain();
            });
    }
}

// ---------------------------------------------------------------------------
// HTTP 工具
// ---------------------------------------------------------------------------

function readRawBody(req, limitBytes = 64 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > limitBytes) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function sendJson(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Access-Control-Allow-Origin': '*',
    });
    res.end(body);
}

function sendError(res, status, message, code) {
    sendJson(res, status, { statusCode: status, message, ...(code ? { code } : {}) });
}

/** 从请求体解析出 NAI 官方 JSON（支持 JSON 与 multipart/form-data）。 */
function extractNaiRequest(req, rawBody) {
    const contentType = String(req.headers['content-type'] || '');
    if (contentType.toLowerCase().startsWith('multipart/form-data')) {
        const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
        const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]).trim() : '';
        const { fields } = parseMultipart(rawBody, boundary);
        if (!fields.request) throw new Error('multipart 请求缺少 request 字段');
        return JSON.parse(fields.request);
    }
    if (rawBody.length === 0) throw new Error('请求体为空');
    return JSON.parse(rawBody.toString('utf8'));
}

/** 若返回的是 ZIP（例如 Gemini 模型），从中取出第一个 PNG。 */
export function maybeExtractPngFromZip(buffer) {
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) return buffer;

    let offset = 0;
    while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
        const method = buffer.readUInt16LE(offset + 8);
        const compSize = buffer.readUInt32LE(offset + 18);
        const nameLen = buffer.readUInt16LE(offset + 26);
        const extraLen = buffer.readUInt16LE(offset + 28);
        const nameStart = offset + 30;
        const name = buffer.slice(nameStart, nameStart + nameLen).toString('utf8');
        const dataStart = nameStart + nameLen + extraLen;

        if (compSize > 0 && dataStart + compSize <= buffer.length && /\.png$/i.test(name)) {
            const raw = buffer.slice(dataStart, dataStart + compSize);
            try {
                return method === 0 ? raw : inflateRawSync(raw);
            } catch {
                return buffer;
            }
        }
        if (compSize === 0) break; // 使用了 data descriptor，放弃解析
        offset = dataStart + compSize;
    }
    return buffer;
}

export class UpstreamError extends Error {
    constructor(status, message, detail) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}

/**
 * 从上游错误响应体中提取 V5 周额度的权威数据。
 * 文档：额度不足时返回 HTTP 429 与稳定错误码 NOVELAI_V5_WEEKLY_QUOTA_EXCEEDED，
 * 响应同时包含 success / pending / limit / remaining / reset_at。
 * @returns {{limit?:number, remaining?:number, reset_at?:string}|null}
 */
export function extractV5QuotaError(bodyText) {
    let data;
    try {
        data = JSON.parse(bodyText);
    } catch {
        return null;
    }
    if (!data || typeof data !== 'object') return null;

    const code = String(data.code || data.error_code || data.stable_code || '');
    const hasQuotaFields = data.limit !== undefined || data.remaining !== undefined;
    if (!code.includes('V5_WEEKLY_QUOTA') && !hasQuotaFields) return null;

    const out = {};
    const limit = Number(data.limit);
    if (Number.isFinite(limit) && limit > 0) out.limit = limit;
    const remaining = Number(data.remaining);
    if (Number.isFinite(remaining)) out.remaining = Math.max(0, remaining);
    if (typeof data.reset_at === 'string' && data.reset_at) out.reset_at = data.reset_at;
    return Object.keys(out).length > 0 ? out : null;
}

// ---------------------------------------------------------------------------
// 服务器工厂
// ---------------------------------------------------------------------------

export function createProxyServer(config) {
    const log = (level, message, extra) => {
        const order = { error: 0, warn: 1, info: 2, debug: 3 };
        if ((order[level] ?? 2) > (order[config.logLevel] ?? 2)) return;
        const stamp = new Date().toISOString();
        const suffix = extra === undefined ? '' : ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
        process.stdout.write(`[${stamp}] [${level.toUpperCase()}] ${message}${suffix}\n`);
    };

    const queue = new SerialQueue({
        maxConcurrency: config.maxConcurrency,
        minIntervalMs: config.minIntervalMs,
    });

    const quota = new QuotaTracker({
        dataFile: config.quotaFile,
        dailyLimit: config.dailyLimit,
        v5WeeklyLimit: config.v5WeeklyLimit,
        dailyValueMode: config.dailyValueMode,
        v5PercentMode: config.v5PercentMode,
        log: (msg) => log('warn', msg),
    });

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /**
     * 取出客户端提供的 Bearer token（不做任何替换）。
     * 用于判断客户端是否已按 NovelAI 契约带上凭据。
     */
    function clientBearer(clientAuthHeader) {
        const m = /^Bearer\s+(.+)$/i.exec(String(clientAuthHeader || '').trim());
        return m ? m[1].trim() : '';
    }

    /**
     * 解析本次请求应发往上游的 IDLECLOUD API Key。
     *
     * 注意：即使配置了 IDLECLOUD_API_KEY，客户端**仍必须**带上 Authorization
     * （NovelAI 客户端本来就会带）。凭据校验与 Key 替换是两件事：
     * 前者保证接口不被匿名访问，后者决定用哪个 Key 请求上游。
     */
    function resolveApiKey(clientAuthHeader) {
        if (config.apiKey) return config.apiKey;
        if (!config.authPassthrough) return '';
        return clientBearer(clientAuthHeader);
    }

    function upstreamHeaders(apiKey) {
        return {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        };
    }

    async function fetchWithTimeout(url, options = {}, timeoutMs = 60000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    function resolveUrl(maybeRelative) {
        if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
        return `${config.baseUrl}${maybeRelative.startsWith('/') ? '' : '/'}${maybeRelative}`;
    }

    async function fetchBinary(url, apiKey) {
        const res = await fetchWithTimeout(url, {
            method: 'GET',
            headers: { Authorization: `Bearer ${apiKey}` },
        }, 120000);
        if (!res.ok) throw new UpstreamError(502, `下载结果失败: HTTP ${res.status}`, url);
        return Buffer.from(await res.arrayBuffer());
    }

    async function confirmV5Delivery(delivery, buffer, apiKey) {
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        if (typeof delivery.sha256 === 'string' && delivery.sha256 && delivery.sha256 !== sha256) {
            throw new UpstreamError(502, 'V5 结果 SHA-256 校验失败',
                `期望 ${delivery.sha256.slice(0, 12)}… 实际 ${sha256.slice(0, 12)}…`);
        }
        if (typeof delivery.size_bytes === 'number' && delivery.size_bytes > 0 && delivery.size_bytes !== buffer.length) {
            throw new UpstreamError(502, 'V5 结果字节数校验失败', `期望 ${delivery.size_bytes} 实际 ${buffer.length}`);
        }

        const confirmUrl = resolveUrl(delivery.confirm_url || `/api/v5-results/${delivery.id}/confirm`);
        try {
            const res = await fetchWithTimeout(confirmUrl, {
                method: 'POST',
                headers: upstreamHeaders(apiKey),
                body: JSON.stringify({ sha256, size_bytes: buffer.length }),
            }, 60000);
            if (!res.ok) log('warn', 'V5 交付确认未成功（结果仍返回）', { status: res.status });
        } catch (error) {
            log('warn', 'V5 交付确认请求异常（结果仍返回）', String(error));
        }
    }

    /**
     * 提交生成任务并轮询直到拿到图片字节。
     * @returns {Promise<Buffer>} PNG 字节
     */
    async function submitAndPoll(payload, apiKey, jobLabel) {
        const submitUrl = `${config.baseUrl}/api/generate_image`;
        const submitRes = await fetchWithTimeout(submitUrl, {
            method: 'POST',
            headers: upstreamHeaders(apiKey),
            body: JSON.stringify(payload),
        }, 60000);

        const submitText = await submitRes.text();
        if (!submitRes.ok) {
            // 上游 429 若携带 V5 周额度的权威数据（limit / remaining / reset_at），
            // 用它校正本地计数，避免客户端显示偏高的剩余量。
            const quotaInfo = extractV5QuotaError(submitText);
            if (quotaInfo) {
                const snap = quota.applyV5QuotaError(quotaInfo);
                log('warn', 'V5 周额度已用尽，已按上游数据校正', {
                    limit: snap.v5Limit,
                    remaining: snap.v5Remaining,
                });
            }
            throw new UpstreamError(submitRes.status, `提交任务失败: HTTP ${submitRes.status}`, submitText.slice(0, 300));
        }

        let submitData;
        try {
            submitData = JSON.parse(submitText);
        } catch {
            throw new UpstreamError(502, '提交任务返回非 JSON', submitText.slice(0, 300));
        }

        const jobId = submitData.job_id;
        if (!jobId) {
            throw new UpstreamError(502, '提交任务未返回 job_id', submitText.slice(0, 300));
        }
        log('info', `${jobLabel} 已提交`, { job_id: jobId, queue_position: submitData.queue_position });

        const deadline = Date.now() + config.requestTimeoutMs;
        const resultUrl = `${config.baseUrl}/api/get_result/${encodeURIComponent(jobId)}`;

        while (Date.now() < deadline) {
            await sleep(config.pollIntervalMs);
            const res = await fetchWithTimeout(resultUrl, {
                method: 'GET',
                headers: upstreamHeaders(apiKey),
            }, 60000);

            if (!res.ok) {
                const text = await res.text().catch(() => '');
                log('warn', '轮询失败，继续重试', { status: res.status, body: text.slice(0, 200) });
                continue;
            }

            const data = await res.json().catch(() => null);
            if (!data) continue;

            if (data.status === 'failed') {
                throw new UpstreamError(500, data.error || '上游生成失败', JSON.stringify(data).slice(0, 300));
            }

            if (data.status === 'completed') {
                const delivery = data.v5_delivery;
                let buffer;

                if (delivery && delivery.confirmation_required && (delivery.file_url || delivery.id)) {
                    // V5 私有交付：下载原图 -> 校验 -> 确认
                    const fileUrl = resolveUrl(delivery.file_url || `/api/v5-results/${delivery.id}/file`);
                    buffer = await fetchBinary(fileUrl, apiKey);
                    await confirmV5Delivery(delivery, buffer, apiKey);
                } else if (data.image_url) {
                    buffer = await fetchBinary(resolveUrl(data.image_url), apiKey);
                } else if (data.video_url) {
                    throw new UpstreamError(502, '本次请求返回的是视频，图像接口无法承载', '');
                } else {
                    throw new UpstreamError(502, '任务完成但响应中没有 image_url', JSON.stringify(data).slice(0, 300));
                }

                return maybeExtractPngFromZip(buffer);
            }
            // queued / processing -> 继续轮询
        }

        throw new UpstreamError(504, '等待生成结果超时', `job_id=${jobId}`);
    }

    /** 鉴权探测与额度查询端点：把 IDLECLOUD 额度映射成 NovelAI 官方字段。 */
    function novelSubscription() {
        return buildNovelSubscription(quota.snapshot(), { tier: config.tier });
    }

    function novelInformation() {
        return buildNovelInformation(quota.snapshot());
    }

    async function handleGenerateImage(req, res, apiKey) {
        const rawBody = await readRawBody(req);
        let naiRequest;
        try {
            naiRequest = extractNaiRequest(req, rawBody);
        } catch (error) {
            return sendError(res, 400, `无法解析 NovelAI 请求体: ${error.message}`, 'BAD_REQUEST');
        }

        const payload = convertNaiToGeneral(naiRequest, {});
        const isV5 = isV5Model(payload.model);
        const isBigImage = isBigImageRequest(payload, config.normalStepsLimit);

        log('info', '生成请求', {
            model: payload.model,
            size: `${payload.width ?? '-'}x${payload.height ?? '-'}`,
            steps: payload.steps ?? '-',
            img2img: payload.action === true,
            inpaint: Boolean(payload.mask),
            isV5,
            isBigImage,
        });

        const png = await queue.run(() => submitAndPoll(payload, apiKey, 'generate-image'));

        // 生成成功后才记账：大图走大图点数，不占每日次数与 V5 周额度
        const snap = quota.recordGeneration({ isV5, isBigImage });
        log('info', '额度已更新', {
            每日剩余: `${snap.dailyRemaining}/${snap.dailyLimit}`,
            V5每周剩余: `${snap.v5Remaining}/${snap.v5Limit}`,
            V5充能: snap.v5Percent,
        });

        const zip = createZip([{ name: 'image.png', data: png }]);
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zip.length,
            'Access-Control-Allow-Origin': '*',
        });
        res.end(zip);
    }

    async function handleAugmentImage(req, res, apiKey) {
        const rawBody = await readRawBody(req);
        let naiRequest;
        try {
            naiRequest = JSON.parse(rawBody.toString('utf8'));
        } catch (error) {
            return sendError(res, 400, `无法解析请求体: ${error.message}`, 'BAD_REQUEST');
        }

        const payload = convertAugmentToGeneral(naiRequest, { augmentModel: config.augmentModel });
        log('info', '图像工具请求', { req_type: payload.req_type, model: payload.model });

        const png = await queue.run(() => submitAndPoll(payload, apiKey, 'augment-image'));
        const zip = createZip([{ name: 'image.png', data: png }]);
        res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': zip.length,
            'Access-Control-Allow-Origin': '*',
        });
        res.end(zip);
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization,Content-Type',
            });
            return res.end();
        }

        const apiKey = resolveApiKey(req.headers.authorization);

        // 内置图标：容器模板的 <Icon> 指向 http://<IP>:<PORT>/icon.png
        if (path === '/icon.png') {
            if (!ICON_PNG) {
                return sendError(res, 404, 'icon.png 未打包进镜像', 'NOT_FOUND');
            }
            res.writeHead(200, {
                'Content-Type': 'image/png',
                'Content-Length': ICON_PNG.length,
                'Cache-Control': 'public, max-age=86400',
            });
            return res.end(ICON_PNG);
        }

        if (path === '/' || path === '/healthz') {
            return sendJson(res, 200, {
                ok: true,
                service: 'nai-idlecloud-proxy',
                version: VERSION,
                upstream: config.baseUrl,
                endpoint: '/api/generate_image',
                key_configured: Boolean(config.apiKey),
                // 额度快照：便于排障与外部监控
                quota: quota.snapshot(),
            });
        }

        try {
            // 鉴权：与 NovelAI 官方一致，客户端必须带上 Bearer 凭据。
            // 这里校验的是「客户端有没有带」，与「上游用哪个 Key」无关：
            // 配置了 IDLECLOUD_API_KEY 时，客户端仍须带（内容随意）。
            if (!clientBearer(req.headers.authorization)) {
                return sendError(res, 401, 'Missing or invalid Authorization header', 'MISSING_AUTH');
            }
            if (!apiKey) {
                return sendError(res, 401, 'No upstream API key available', 'MISSING_UPSTREAM_KEY');
            }

            switch (path) {
                case '/ai/generate-image':
                    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
                    return await handleGenerateImage(req, res, apiKey);

                case '/ai/augment-image':
                    if (req.method !== 'POST') return sendError(res, 405, 'Method Not Allowed');
                    return await handleAugmentImage(req, res, apiKey);

                // 客户端启动时的鉴权探测端点 + 额度查询端点
                case '/user/subscription':
                case '/user/data':
                    return sendJson(res, 200, novelSubscription());

                case '/user/information':
                    return sendJson(res, 200, novelInformation());

                case '/ai/upscale':
                    return sendError(res, 501, 'IDLECLOUD 通用端点不提供放大功能（/ai/upscale）', 'NOT_IMPLEMENTED');

                case '/ai/generate-voice':
                    return sendError(res, 501, 'IDLECLOUD 不提供语音合成（/ai/generate-voice）', 'NOT_IMPLEMENTED');

                // NovelAI 文本补全走 text.novelai.net；IDLECLOUD 只有 Grok 对话接口，
                // 与文本补全语义差异过大，不做有损映射，明确拒绝以免客户端拿到错误内容。
                case '/ai/generate':
                case '/ai/generate-stream':
                    return sendError(
                        res,
                        501,
                        'IDLECLOUD 未提供与 NovelAI 文本补全等价的接口（其 /api/chat 为 Grok 对话模型，语义不同）',
                        'NOT_IMPLEMENTED',
                    );

                default:
                    // /ai/* 下的未知端点按「功能未实现」回复，便于客户端区分「地址错误」与「功能缺失」
                    if (path.startsWith('/ai/')) {
                        return sendError(res, 501, `IDLECLOUD 未提供该功能: ${path}`, 'NOT_IMPLEMENTED');
                    }
                    return sendError(res, 404, `未支持的端点: ${path}`, 'NOT_FOUND');
            }
        } catch (error) {
            if (error instanceof UpstreamError) {
                log('error', error.message, error.detail);
                return sendError(res, error.status, error.message, 'UPSTREAM_ERROR');
            }
            log('error', '处理请求异常', String(error && error.stack ? error.stack : error));
            return sendError(res, 500, String(error && error.message ? error.message : error), 'INTERNAL_ERROR');
        }
    });

    server.config = config;
    server.log = log;
    // 暴露给测试注入额度状态（生产代码不依赖）
    server.quotaForTest = quota;
    return server;
}

// ---------------------------------------------------------------------------
// 直接运行时启动
// ---------------------------------------------------------------------------

function isMain() {
    if (!process.argv[1]) return false;
    return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
    const config = loadConfig();
    const server = createProxyServer(config);
    server.listen(config.port, '0.0.0.0', () => {
        server.log('info', `NAI -> IDLECLOUD 转换代理已启动: http://0.0.0.0:${config.port}`);
        server.log('info', '上游', {
            base: config.baseUrl,
            endpoint: '/api/generate_image (通用端点)',
            key_configured: Boolean(config.apiKey),
            auth_passthrough: config.authPassthrough,
            min_interval_s: config.minIntervalMs / 1000,
            poll_interval_s: config.pollIntervalMs / 1000,
            request_timeout_s: config.requestTimeoutMs / 1000,
            max_concurrency: config.maxConcurrency,
        });
    });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            server.log('info', `收到 ${signal}，正在退出`);
            server.close(() => process.exit(0));
            setTimeout(() => process.exit(0), 3000).unref();
        });
    }
}
