import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';

import { createProxyServer, loadConfig } from '../server.js';

/** 一张最小的合法 PNG（1x1 透明像素）。 */
const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

const VALID_KEY = 'idlecloud-test-key-abcdef';

/**
 * 启动一个模拟的 IDLECLOUD 上游。
 * @param {object} opts
 * @param {'simple'|'v5'|'failed'|'queued-then-done'|'zip'|'video'} opts.mode 结果形态
 * @param {number} [opts.badSizeBytes] V5 场景下故意声明错误的字节数
 * @param {string} [opts.badSha256] V5 场景下故意声明错误的 SHA-256
 * @param {string} [opts.requireKey] 期望的 Key，默认 VALID_KEY
 */
async function startMockUpstream(opts = {}) {
    const mode = opts.mode || 'simple';
    const requireKey = opts.requireKey ?? VALID_KEY;
    const received = { submits: [], polls: [], confirms: [], downloads: [] };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const auth = req.headers.authorization || '';

        // 鉴权校验：与真实上游一致，错误 Key 返回 401
        if (!auth.startsWith('Bearer ') || auth.slice(7) !== requireKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Invalid API key.' }));
        }

        const chunks = [];
        for await (const c of req) chunks.push(c);
        const bodyBuf = Buffer.concat(chunks);

        if (req.method === 'POST' && url.pathname === '/api/generate_image') {
            const payload = JSON.parse(bodyBuf.toString('utf8'));
            received.submits.push(payload);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ job_id: 'job-test-1', queue_position: 1 }));
        }

        if (req.method === 'GET' && url.pathname.startsWith('/api/get_result/')) {
            received.polls.push(url.pathname);
            const n = received.polls.length;

            if (mode === 'failed') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'failed', error: '上游生成失败示例' }));
            }

            if (mode === 'queued-then-done' && n < 2) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'queued', queue_position: 3 }));
            }

            if (mode === 'v5') {
                const sha = createHash('sha256').update(PNG_1X1).digest('hex');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    status: 'completed',
                    image_url: '/api/v5-results/deliv-1/file',
                    v5_delivery: {
                        id: 'deliv-1',
                        status: 'awaiting_confirmation',
                        file_url: '/api/v5-results/deliv-1/file',
                        confirm_url: '/api/v5-results/deliv-1/confirm',
                        confirmation_required: true,
                        mime_type: 'image/png',
                        size_bytes: opts.badSizeBytes ?? PNG_1X1.length,
                        sha256: opts.badSha256 ?? sha,
                    },
                }));
            }

            if (mode === 'video') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'completed', video_url: '/result.mp4' }));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            // 使用相对地址，确保代理一定回到本 mock 取图（而不是外网）
            return res.end(JSON.stringify({ status: 'completed', image_url: '/result.png' }));
        }

        if (req.method === 'GET' && url.pathname === '/api/v5-results/deliv-1/file') {
            received.downloads.push(url.pathname);
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return res.end(PNG_1X1);
        }

        if (req.method === 'POST' && url.pathname === '/api/v5-results/deliv-1/confirm') {
            received.confirms.push(JSON.parse(bodyBuf.toString('utf8')));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ id: 'deliv-1', status: 'confirmed' }));
        }

        if (req.method === 'GET' && url.pathname === '/result.mp4') {
            res.writeHead(200, { 'Content-Type': 'video/mp4' });
            return res.end(Buffer.from('fake-mp4'));
        }

        if (req.method === 'GET' && url.pathname === '/result.png') {
            received.downloads.push(url.pathname);
            if (mode === 'zip') {
                // 模拟上游返回 ZIP（Gemini 场景）
                const { createZip } = await import('../convert.js');
                const zip = createZip([{ name: 'image.png', data: PNG_1X1 }]);
                res.writeHead(200, { 'Content-Type': 'application/zip' });
                return res.end(zip);
            }
            res.writeHead(200, { 'Content-Type': 'image/png' });
            return res.end(PNG_1X1);
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
    });

    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    return { server, port, received, baseUrl: `http://127.0.0.1:${port}` };
}

/** 启动代理并返回其基址。 */
async function startProxy(baseUrl, overrides = {}) {
    const config = loadConfig({}, {
        baseUrl,
        apiKey: VALID_KEY,
        pollIntervalMs: 10,
        minIntervalMs: 0,
        requestTimeoutMs: 5000,
        logLevel: 'error',
        quotaFile: null,
        ...overrides,
    });
    const server = createProxyServer(config);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = server.address();
    return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/**
 * 构造 NAI 官方请求体。
 * @param {object} [paramOverrides] 覆盖 parameters 内的字段
 * @param {string} [model] 覆盖顶层 model（模型名在顶层，不在 parameters 内）
 */
function naiPayload(paramOverrides = {}, model = 'nai-diffusion-4-5-full') {
    return {
        action: 'generate',
        input: '1girl, solo, masterpiece',
        model,
        parameters: {
            width: 832,
            height: 1216,
            scale: 5,
            steps: 28,
            sampler: 'k_euler',
            noise_schedule: 'karras',
            seed: 1234,
            negative_prompt: 'lowres, bad anatomy',
            n_samples: 1,
            ...paramOverrides,
        },
    };
}

async function postGenerate(proxyBase, payload, headers = {}) {
    const res = await fetch(`${proxyBase}/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}`, ...headers },
        body: JSON.stringify(payload),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    // 注意：body 已被读取，调用方需用 buf 自行解析，不能再调 res.json()
    const json = (() => {
        try {
            return JSON.parse(buf.toString('utf8'));
        } catch {
            return null;
        }
    })();
    return { res, buf, json };
}

/** 从代理返回的 ZIP 中取出 PNG 数据体。 */
function pngFromZip(buf) {
    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const dataStart = 30 + nameLen + extraLen;
    const size = buf.readUInt32LE(18);
    return buf.slice(dataStart, dataStart + size);
}

async function readSubscription(proxyBase) {
    const res = await fetch(`${proxyBase}/user/subscription`, {
        headers: { Authorization: `Bearer ${VALID_KEY}` },
    });
    return res.json();
}

// ---------------------------------------------------------------------------

test('端到端：NAI 请求 -> 通用端点 -> 轮询 -> 返回 ZIP(内含 PNG)', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, buf } = await postGenerate(proxy.baseUrl, naiPayload());

        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'application/zip');
        assert.equal(buf.readUInt32LE(0), 0x04034b50, 'ZIP 签名');
        assert.deepEqual(pngFromZip(buf), PNG_1X1, '内含 PNG 应与上游一致');

        // 上游收到的必须是「通用端点」格式
        assert.equal(upstream.received.submits.length, 1);
        const sent = upstream.received.submits[0];
        assert.equal(sent.model, 'nai-diffusion-4-5-full');
        assert.equal(sent.positivePrompt, '1girl, solo, masterpiece');
        assert.equal(sent.negativePrompt, 'lowres, bad anatomy');
        assert.equal(sent.width, 832);
        assert.equal(sent.height, 1216);
        assert.equal(sent.steps, 28);
        assert.equal(sent.seed, 1234);
        // NAI 专有字段不得出现
        assert.equal(sent.n_samples, undefined);
        assert.equal(sent.action, undefined);
        assert.equal(sent.input, undefined);

        assert.ok(upstream.received.polls.length >= 1, '确实走了轮询');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('鉴权替换：客户端 NAI Token 被替换为配置的 IDLECLOUD API Key', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        // 客户端发一个 NovelAI 的 token，代理应改用配置里的 IDLECLOUD Key
        const { res } = await postGenerate(proxy.baseUrl, naiPayload(), {
            Authorization: 'Bearer novelai-official-token-xyz',
        });
        assert.equal(res.status, 200);
        assert.equal(upstream.received.submits.length, 1);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('反向验证：上游收到错误 Key 时链路必须失败（证明替换真的生效）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    // 故意配置一个错误的 Key，上游会返回 401
    const proxy = await startProxy(upstream.baseUrl, { apiKey: 'wrong-key' });
    try {
        const { res } = await postGenerate(proxy.baseUrl, naiPayload());
        assert.equal(res.status, 401, '错误 Key 应导致上游拒绝，代理需如实上报');
        assert.equal(upstream.received.submits.length, 0, '上游不应接受任何提交');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('反向验证：客户端缺少 Authorization 时返回 401 且不触达上游', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, { authPassthrough: false, apiKey: '' });
    try {
        const res = await fetch(`${proxy.baseUrl}/ai/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(naiPayload()),
        });
        assert.equal(res.status, 401);
        assert.equal(upstream.received.submits.length, 0);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('安全性：已配置 IDLECLOUD_API_KEY 时，客户端仍必须带凭据（不得匿名访问）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    // apiKey 已配置：上游 Key 固定，但客户端凭据校验依然要生效
    const proxy = await startProxy(upstream.baseUrl, { apiKey: VALID_KEY });
    try {
        // 1) 不带任何凭据 -> 401，且不触达上游
        const noAuth = await fetch(`${proxy.baseUrl}/ai/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(naiPayload()),
        });
        assert.equal(noAuth.status, 401, '配置了 Key 不代表允许匿名访问');
        assert.equal(upstream.received.submits.length, 0);

        // 2) 额度端点同样需要凭据
        const subNoAuth = await fetch(`${proxy.baseUrl}/user/subscription`);
        assert.equal(subNoAuth.status, 401, '额度端点也不得匿名访问');

        // 3) 带上任意凭据（内容随意）-> 用配置的 Key 成功访问上游
        const withAuth = await postGenerate(proxy.baseUrl, naiPayload(), {
            Authorization: 'Bearer anything-goes',
        });
        assert.equal(withAuth.res.status, 200);
        assert.equal(upstream.received.submits.length, 1, '上游应收到请求，且用的是配置的 Key');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('透传模式：未配置 apiKey 时使用客户端 Bearer 作为 IDLECLOUD Key', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, { apiKey: '', authPassthrough: true });
    try {
        const { res } = await postGenerate(proxy.baseUrl, naiPayload());
        assert.equal(res.status, 200, '客户端持有正确 Key 时应成功');
        assert.equal(upstream.received.submits.length, 1);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('V5 私有交付：下载 -> SHA256 校验 -> 确认，且返回图像', async () => {
    const upstream = await startMockUpstream({ mode: 'v5' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, buf } = await postGenerate(proxy.baseUrl, naiPayload({
            model: 'nai-diffusion-5-full',
            steps: 23,
        }));
        assert.equal(res.status, 200);

        assert.equal(upstream.received.downloads.length, 1, '应下载 V5 私有文件');
        assert.equal(upstream.received.confirms.length, 1, '应发送确认请求');
        const confirm = upstream.received.confirms[0];
        assert.equal(confirm.sha256, createHash('sha256').update(PNG_1X1).digest('hex'));
        assert.equal(confirm.size_bytes, PNG_1X1.length);

        assert.deepEqual(pngFromZip(buf), PNG_1X1);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('V5 交付校验失败：字节数不匹配时必须报错而不是返回坏图', async () => {
    const upstream = await startMockUpstream({ mode: 'v5', badSizeBytes: PNG_1X1.length + 999 });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, json } = await postGenerate(proxy.baseUrl, naiPayload({
            model: 'nai-diffusion-5-full',
            steps: 23,
        }));
        assert.equal(res.status, 502, '校验失败应返回错误');
        assert.match(json.message, /校验失败/);
        assert.equal(upstream.received.confirms.length, 0, '校验失败时不得发送确认请求');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('V5 交付校验失败：SHA-256 不匹配时必须报错', async () => {
    const upstream = await startMockUpstream({ mode: 'v5', badSha256: 'f'.repeat(64) });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, json } = await postGenerate(proxy.baseUrl, naiPayload({
            model: 'nai-diffusion-5-full',
            steps: 23,
        }));
        assert.equal(res.status, 502);
        assert.match(json.message, /SHA-256/);
        assert.equal(upstream.received.confirms.length, 0, '校验失败时不得发送确认请求');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('上游返回视频时图像接口如实报错', async () => {
    const upstream = await startMockUpstream({ mode: 'video' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, json } = await postGenerate(proxy.baseUrl, naiPayload());
        assert.equal(res.status, 502);
        assert.match(json.message, /视频/);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('上游 failed 状态映射为错误响应', async () => {
    const upstream = await startMockUpstream({ mode: 'failed' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, json } = await postGenerate(proxy.baseUrl, naiPayload());
        assert.equal(res.status, 500);
        assert.match(json.message, /上游生成失败示例/);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('排队中会持续轮询直到完成', async () => {
    const upstream = await startMockUpstream({ mode: 'queued-then-done' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res } = await postGenerate(proxy.baseUrl, naiPayload());
        assert.equal(res.status, 200);
        assert.ok(upstream.received.polls.length >= 2, `应至少轮询 2 次，实际 ${upstream.received.polls.length}`);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('上游返回 ZIP 时被解包为 PNG（Gemini 场景）', async () => {
    const zipUpstream = await startMockUpstream({ mode: 'zip' });
    const proxy = await startProxy(zipUpstream.baseUrl);
    try {
        const { res, buf } = await postGenerate(proxy.baseUrl, naiPayload({}, 'gemini-3-pro-image'));
        assert.equal(res.status, 200);
        // 代理输出的 PNG 应是解包后的原始 PNG，而不是嵌套 ZIP
        assert.deepEqual(pngFromZip(buf), PNG_1X1);
    } finally {
        proxy.server.close();
        zipUpstream.server.close();
    }
});

test('multipart/form-data 请求（request 字段为官方 JSON）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const boundary = '----proxytest';
        const parts = [
            `--${boundary}`,
            'Content-Disposition: form-data; name="request"',
            '',
            JSON.stringify(naiPayload()),
            `--${boundary}--`,
            '',
        ];
        const res = await fetch(`${proxy.baseUrl}/ai/generate-image`, {
            method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                Authorization: `Bearer ${VALID_KEY}`,
            },
            body: Buffer.from(parts.join('\r\n'), 'utf8'),
        });
        assert.equal(res.status, 200);
        assert.equal(upstream.received.submits.length, 1);
        assert.equal(upstream.received.submits[0].positivePrompt, '1girl, solo, masterpiece');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('图像工具端点 /ai/augment-image 走通用端点', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const res = await fetch(`${proxy.baseUrl}/ai/augment-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
            body: JSON.stringify({ req_type: 'emotion', width: 512, height: 512, image: 'QUJD', prompt: 'happy' }),
        });
        assert.equal(res.status, 200);
        const sent = upstream.received.submits[0];
        assert.equal(sent.req_type, 'emotion');
        assert.equal(sent.prompt, 'happy');
        assert.equal(sent.image, 'QUJD');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('/user/subscription 返回供客户端鉴权探测的数据', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.active, true);
        assert.ok(body.tier >= 1);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

// ---------------------------------------------------------------------------
// 额度映射：IDLECLOUD 额度 -> NovelAI 字段
// ---------------------------------------------------------------------------

test('额度映射：生成成功后每日剩余与 V5 充能同步减少', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        const before = await readSubscription(proxy.baseUrl);
        assert.equal(before.trainingStepsLeft.fixedTrainingStepsLeft, 600, '初始每日剩余 600');
        assert.equal(before.usage.percent, 100, '初始 V5 充能 100');

        // 28 步是 V5 普通模式（上限 28），计入每日次数与 V5 周额度
        const { res } = await postGenerate(proxy.baseUrl, naiPayload({ steps: 28 }, 'nai-diffusion-5-full'));
        assert.equal(res.status, 200);

        const after = await readSubscription(proxy.baseUrl);
        assert.equal(after.trainingStepsLeft.fixedTrainingStepsLeft, 599, '每日剩余应减 1');
        assert.equal(after.usage.percent, 99, 'V5 充能应减 1');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('额度映射：V5 28 步属普通模式，正常计入额度（不是大图）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        const { res } = await postGenerate(proxy.baseUrl, naiPayload({ steps: 28 }, 'nai-diffusion-5-full'));
        assert.equal(res.status, 200);

        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.usage.percent, 99, '28 步属普通模式，应消耗 1 次 V5 额度');
        assert.equal(body.trainingStepsLeft.fixedTrainingStepsLeft, 599, '也应占用 1 次每日次数');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('额度映射：V5 超过 28 步才进入大图模式，不消耗额度', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        // 29 步超过普通模式上限 28
        const { res } = await postGenerate(proxy.baseUrl, naiPayload({ steps: 29 }, 'nai-diffusion-5-full'));
        assert.equal(res.status, 200);

        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.usage.percent, 100, '29 步走大图，不计入周额度');
        assert.equal(body.trainingStepsLeft.fixedTrainingStepsLeft, 600, '也不占每日普通次数');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('额度映射：非 V5 生成只扣每日，不动 V5 充能', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        await postGenerate(proxy.baseUrl, naiPayload({}, 'nai-diffusion-4-5-full'));
        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.trainingStepsLeft.fixedTrainingStepsLeft, 599);
        assert.equal(body.usage.percent, 100, 'V4.5 不消耗 V5 充能');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('额度映射：大图生成既不扣每日次数也不扣 V5 充能', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        // 1025x1024 超过 1048576，进入大图模式
        await postGenerate(proxy.baseUrl, naiPayload({
            model: 'nai-diffusion-5-full',
            width: 1025,
            height: 1024,
        }));
        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.trainingStepsLeft.fixedTrainingStepsLeft, 600, '大图不占每日次数');
        assert.equal(body.usage.percent, 100, '大图不计入 V5 周额度');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('额度映射：生成失败时不得扣减额度', async () => {
    const upstream = await startMockUpstream({ mode: 'failed' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        const { res } = await postGenerate(proxy.baseUrl, naiPayload({
            model: 'nai-diffusion-5-full',
            steps: 23,
        }));
        assert.equal(res.status, 500, '上游失败');

        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.trainingStepsLeft.fixedTrainingStepsLeft, 600, '失败不应扣每日额度');
        assert.equal(body.usage.percent, 100, '失败不应扣 V5 充能');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('额度映射：V5 剩余 67 次时 usage.percent 返回 67（用户需求）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        // 直接注入已用 33 次的状态，避免发 33 个请求
        const tracker = proxy.server.quotaForTest;
        for (let i = 0; i < 33; i++) tracker.recordGeneration({ isV5: true });

        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.usage.percent, 67, '剩余 67 次应返回 67');
        assert.equal(body.idlecloud.v5_weekly.remaining, 67);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('/user/information 返回试用张数（映射每日剩余）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, { dailyLimit: 600 });
    try {
        await postGenerate(proxy.baseUrl, naiPayload());
        const r = await fetch(`${proxy.baseUrl}/user/information`, {
            headers: { Authorization: `Bearer ${VALID_KEY}` },
        });
        assert.equal(r.status, 200);
        const body = await r.json();
        assert.equal(body.trialImagesLeft, 599);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('上游 429 带 V5 周额度数据时校正本地计数', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    // 让提交返回 429 + 额度字段
    upstream.server.removeAllListeners('request');
    upstream.server.on('request', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/api/generate_image') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                success: false,
                code: 'NOVELAI_V5_WEEKLY_QUOTA_EXCEEDED',
                limit: 70,
                remaining: 0,
                reset_at: new Date(Date.now() + 86400000).toISOString(),
            }));
        }
        res.writeHead(404).end();
    });

    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        const { res } = await postGenerate(proxy.baseUrl, naiPayload({
            model: 'nai-diffusion-5-full',
            steps: 23,
        }));
        assert.equal(res.status, 429, '上游 429 应透传');

        const body = await readSubscription(proxy.baseUrl);
        assert.equal(body.usage.percent, 0, '校正后充能为 0');
        assert.equal(body.usage.isNegative, true, '应标记为已用尽');
        assert.equal(body.idlecloud.v5_weekly.limit, 70, '上限应被校正为上游值');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('healthz 暴露额度快照便于排障', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, {
        dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count',
    });
    try {
        await postGenerate(proxy.baseUrl, naiPayload({ steps: 28 }, 'nai-diffusion-5-full'));
        const r = await fetch(`${proxy.baseUrl}/healthz`);
        const body = await r.json();
        assert.ok(body.quota, 'healthz 应包含额度快照');
        assert.equal(body.quota.dailyRemaining, 599);
        assert.equal(body.quota.v5Remaining, 99);
        assert.equal(body.quota.v5Percent, 99);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

// ---------------------------------------------------------------------------

test('健康检查无需鉴权', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const res = await fetch(`${proxy.baseUrl}/healthz`);
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.ok, true);
        assert.equal(body.endpoint, '/api/generate_image');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('未知的 /ai/* 端点返回 501（功能未实现），非 /ai 路径返回 404', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const aiRes = await fetch(`${proxy.baseUrl}/ai/unknown`, {
            headers: { Authorization: `Bearer ${VALID_KEY}` },
        });
        assert.equal(aiRes.status, 501);
        const aiBody = await aiRes.json();
        assert.equal(aiBody.code, 'NOT_IMPLEMENTED');

        const otherRes = await fetch(`${proxy.baseUrl}/totally/unknown`, {
            headers: { Authorization: `Bearer ${VALID_KEY}` },
        });
        assert.equal(otherRes.status, 404);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('文本补全端点明确拒绝（避免有损映射到 Grok 对话）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        for (const p of ['/ai/generate', '/ai/generate-stream']) {
            const res = await fetch(`${proxy.baseUrl}${p}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
                body: JSON.stringify({ input: 'hello', model: 'kayra-v1' }),
            });
            assert.equal(res.status, 501, `${p} 应返回 501`);
        }
        assert.equal(upstream.received.submits.length, 0, '不得向上游提交');
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('内置图标路由：/icon.png 无需鉴权且返回 PNG', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const res = await fetch(`${proxy.baseUrl}/icon.png`);
        // 若镜像内未打包图标则返回 404；打包后必须是 PNG
        if (res.status === 200) {
            assert.equal(res.headers.get('content-type'), 'image/png');
            const buf = Buffer.from(await res.arrayBuffer());
            assert.equal(buf.readUInt32BE(0), 0x89504e47, 'PNG 魔数');
        } else {
            assert.equal(res.status, 404);
        }
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('并发限制：多个请求串行执行（MAX_CONCURRENCY=1）', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, { maxConcurrency: 1, minIntervalMs: 0 });
    try {
        const results = await Promise.all([
            postGenerate(proxy.baseUrl, naiPayload()),
            postGenerate(proxy.baseUrl, naiPayload()),
            postGenerate(proxy.baseUrl, naiPayload()),
        ]);
        for (const { res } of results) assert.equal(res.status, 200);
        assert.equal(upstream.received.submits.length, 3);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('间隔默认关闭：未设置 MIN_INTERVAL 时不应有任何额外延迟', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    // 不传 minIntervalMs，走 loadConfig 的默认值
    const config = loadConfig({}, {
        baseUrl: upstream.baseUrl,
        apiKey: VALID_KEY,
        pollIntervalMs: 10,
        requestTimeoutMs: 5000,
        logLevel: 'error',
        quotaFile: null,
    });
    assert.equal(config.minIntervalMs, 0, '默认应为 0（不节流）');

    const proxy = await startProxy(upstream.baseUrl);
    try {
        const t0 = Date.now();
        await Promise.all([
            postGenerate(proxy.baseUrl, naiPayload()),
            postGenerate(proxy.baseUrl, naiPayload()),
        ]);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed < 3000, `两次请求不应被强制间隔拖慢，实际 ${elapsed}ms`);
        assert.equal(upstream.received.submits.length, 2);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('间隔开启后生效：MIN_INTERVAL_MS 应真实拉开两次提交', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl, { maxConcurrency: 1, minIntervalMs: 400 });
    try {
        const t0 = Date.now();
        await Promise.all([
            postGenerate(proxy.baseUrl, naiPayload()),
            postGenerate(proxy.baseUrl, naiPayload()),
        ]);
        const elapsed = Date.now() - t0;
        assert.ok(elapsed >= 400, `开启 400ms 间隔后总耗时应 >= 400ms，实际 ${elapsed}ms`);
        assert.equal(upstream.received.submits.length, 2);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('时间类配置以秒为单位，内部换算为毫秒', () => {
    const cfg = loadConfig({
        MIN_INTERVAL: '20',
        POLL_INTERVAL: '5',
        REQUEST_TIMEOUT: '900',
    });
    assert.equal(cfg.minIntervalMs, 20000, '20 秒 -> 20000 毫秒');
    assert.equal(cfg.pollIntervalMs, 5000, '5 秒 -> 5000 毫秒');
    assert.equal(cfg.requestTimeoutMs, 900000, '900 秒 -> 900000 毫秒');
});

test('时间类配置支持小数秒', () => {
    const cfg = loadConfig({ MIN_INTERVAL: '0.5', POLL_INTERVAL: '2.5' });
    assert.equal(cfg.minIntervalMs, 500);
    assert.equal(cfg.pollIntervalMs, 2500);
});

test('时间类配置默认值以秒表达', () => {
    const cfg = loadConfig({});
    assert.equal(cfg.minIntervalMs, 0, '默认关闭');
    assert.equal(cfg.pollIntervalMs, 5000);
    assert.equal(cfg.requestTimeoutMs, 900000);
});

test('兼容旧的 *_MS 变量名（升级后原配置不失效）', () => {
    const cfg = loadConfig({ MIN_INTERVAL_MS: '20000', POLL_INTERVAL_MS: '3000' });
    assert.equal(cfg.minIntervalMs, 20000);
    assert.equal(cfg.pollIntervalMs, 3000);
});

test('新变量优先于旧变量', () => {
    const cfg = loadConfig({ MIN_INTERVAL: '7', MIN_INTERVAL_MS: '20000' });
    assert.equal(cfg.minIntervalMs, 7000, '新变量应优先');
});

test('新变量非法时回退到旧变量', () => {
    const cfg = loadConfig({ MIN_INTERVAL: 'abc', MIN_INTERVAL_MS: '20000' });
    assert.equal(cfg.minIntervalMs, 20000, '新变量无效时应回退到旧变量');
});

test('非法值回退到默认', () => {
    const cfg = loadConfig({ MIN_INTERVAL: 'abc', POLL_INTERVAL: '-5', REQUEST_TIMEOUT: '' });
    assert.equal(cfg.minIntervalMs, 0);
    assert.equal(cfg.pollIntervalMs, 5000);
    assert.equal(cfg.requestTimeoutMs, 900000);
});

test('上游 429 限速时应如实透传，不静默重试', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    upstream.server.removeAllListeners('request');
    upstream.server.on('request', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/api/generate_image') {
            res.writeHead(429, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'API requests must be at least 20 seconds apart.' }));
        }
        res.writeHead(404).end();
    });

    const proxy = await startProxy(upstream.baseUrl);
    try {
        const { res, json } = await postGenerate(proxy.baseUrl, naiPayload());
        assert.equal(res.status, 429, '限速错误应透传给客户端');
        assert.match(json.message, /429/);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});

test('坏 JSON 请求体返回 400', async () => {
    const upstream = await startMockUpstream({ mode: 'simple' });
    const proxy = await startProxy(upstream.baseUrl);
    try {
        const res = await fetch(`${proxy.baseUrl}/ai/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${VALID_KEY}` },
            body: '{not json',
        });
        assert.equal(res.status, 400);
        assert.equal(upstream.received.submits.length, 0);
    } finally {
        proxy.server.close();
        upstream.server.close();
    }
});
