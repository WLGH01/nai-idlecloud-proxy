/**
 * 真实上游冒烟测试：验证代理与 https://api.idlecloud.cc 的鉴权契约。
 * 不消耗额度：只发无效 Key 与缺凭据请求，确认错误语义被正确透传。
 *
 * 用法: IDLECLOUD_API_KEY=xxx node scripts/smoke.mjs   (可选，配置后会做一次真实提交)
 */

import { createProxyServer, loadConfig } from '../server.js';
import { once } from 'node:events';

const config = loadConfig({}, {
    baseUrl: 'https://api.idlecloud.cc',
    apiKey: '',
    authPassthrough: true,
    pollIntervalMs: 3000,
    minIntervalMs: 0,
    requestTimeoutMs: 20000,
    logLevel: 'error',
});

const server = createProxyServer(config);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`代理已启动: ${base}`);

const naiBody = {
    action: 'generate',
    input: '1girl, solo, masterpiece',
    model: 'nai-diffusion-4-5-full',
    parameters: {
        width: 832, height: 1216, scale: 5, steps: 28,
        sampler: 'k_euler', noise_schedule: 'karras', seed: 1234,
        negative_prompt: 'lowres', n_samples: 1,
    },
};

let failures = 0;
const check = (label, ok, detail = '') => {
    console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures += 1;
};

// 1. 健康检查
{
    const res = await fetch(`${base}/healthz`);
    const body = await res.json();
    check('健康检查返回 200 且指向通用端点', res.status === 200 && body.endpoint === '/api/generate_image');
}

// 2. 缺少鉴权 -> 401，且不触达上游
{
    const res = await fetch(`${base}/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(naiBody),
    });
    check('缺少 Authorization 返回 401', res.status === 401);
}

// 3. 无效 Key -> 上游 401 被如实透传（证明请求真的发到了 idlecloud）
{
    const res = await fetch(`${base}/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer invalid-smoke-test-key' },
        body: JSON.stringify(naiBody),
    });
    const body = await res.json();
    check('无效 Key 被上游拒绝并透传 401', res.status === 401, `message=${body.message}`);
}

// 4. 鉴权探测端点（合成响应，不发往上游）
{
    const res = await fetch(`${base}/user/subscription`, {
        headers: { Authorization: 'Bearer any-token' },
    });
    const body = await res.json();
    check('/user/subscription 返回合成鉴权数据', res.status === 200 && body.active === true);
}

// 5. 真实生成（仅在提供了 Key 时执行）
if (process.env.IDLECLOUD_API_KEY) {
    const real = createProxyServer(loadConfig({}, {
        ...config,
        apiKey: process.env.IDLECLOUD_API_KEY,
        minIntervalMs: 20000,
        pollIntervalMs: 5000,
        requestTimeoutMs: 600000,
    }));
    real.listen(0, '127.0.0.1');
    await once(real, 'listening');
    const realBase = `http://127.0.0.1:${real.address().port}`;
    console.log('已配置 IDLECLOUD_API_KEY，执行一次真实生成…');

    const res = await fetch(`${realBase}/ai/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer unused' },
        body: JSON.stringify(naiBody),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
    check('真实生成返回 ZIP', res.status === 200 && isZip,
        `status=${res.status} bytes=${buf.length}`);
    if (isZip) {
        const nameLen = buf.readUInt16LE(26);
        const size = buf.readUInt32LE(18);
        const start = 30 + nameLen + buf.readUInt16LE(28);
        const png = buf.slice(start, start + size);
        const isPng = png.length > 8 && png.readUInt32BE(0) === 0x89504e47;
        check('ZIP 内含合法 PNG', isPng, `png_bytes=${png.length}`);
    }
    real.close();
} else {
    console.log('ℹ 未设置 IDLECLOUD_API_KEY，跳过真实生成（不消耗额度）');
}

server.close();
console.log(failures === 0 ? '\n冒烟测试通过。' : `\n冒烟测试失败：${failures} 项。`);
process.exit(failures === 0 ? 0 : 1);
