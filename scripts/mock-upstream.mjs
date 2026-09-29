/**
 * 独立 mock 上游：模拟 IDLECLOUD 通用端点，用于在 unraid 上验证部署后的容器。
 * 仅用于验收测试，不属于交付物运行路径。
 */
import http from 'node:http';

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

const EXPECTED_KEY = process.env.EXPECTED_KEY || 'acceptance-key';
const PORT = Number(process.env.PORT || 8899);

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization || '';
    const seen = { path: url.pathname, auth: auth.replace(/^Bearer\s+/, '').slice(0, 12) + '…' };
    process.stdout.write(`[mock] ${req.method} ${url.pathname} key=${seen.auth}\n`);

    if (!auth.startsWith('Bearer ') || auth.slice(7) !== EXPECTED_KEY) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Invalid API key.' }));
    }

    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);

    if (req.method === 'POST' && url.pathname === '/api/generate_image') {
        const payload = JSON.parse(body.toString('utf8'));
        process.stdout.write(`[mock] 收到转换后请求: ${JSON.stringify({
            model: payload.model,
            positivePrompt: payload.positivePrompt,
            negativePrompt: payload.negativePrompt,
            width: payload.width,
            height: payload.height,
            steps: payload.steps,
            scale: payload.scale,
            seed: payload.seed,
            n_samples: payload.n_samples,
            action: payload.action,
        })}\n`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ job_id: 'acceptance-job-1', queue_position: 1 }));
    }

    if (req.method === 'GET' && url.pathname === '/api/get_result/acceptance-job-1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ status: 'completed', image_url: '/result.png' }));
    }

    if (req.method === 'GET' && url.pathname === '/result.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        return res.end(PNG_1X1);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`[mock] IDLECLOUD mock 上游已启动，端口 ${PORT}，期望 Key=${EXPECTED_KEY}\n`);
});
