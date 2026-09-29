#!/usr/bin/env node
/**
 * 镜像冒烟测试：构建镜像 -> 启动容器 -> 验证健康检查与图标。
 *
 * 存在的意义：单元/集成测试只覆盖源码，无法发现「Dockerfile 漏 COPY 某个模块」
 * 这类问题（曾真实发生：漏了 quota.js，CI 全绿但容器启动即崩溃）。
 * CI 在构建推送前必须跑这一步。
 *
 * 用法: node scripts/docker-smoke.mjs
 */

import { spawnSync } from 'node:child_process';

const IMAGE = process.env.SMOKE_IMAGE || 'nai-idlecloud-proxy:smoke';
const CONTAINER = 'nai-proxy-smoke-test';
const PORT = process.env.SMOKE_PORT || '18788';

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function run(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function fail(msg, detail = '') {
    console.error(`✗ ${msg}`);
    if (detail) console.error(detail.trim().split('\n').slice(-15).join('\n'));
    process.exit(1);
}

// 1) 构建
console.log(`构建镜像 ${IMAGE} …`);
const build = run('docker', ['build', '-t', IMAGE, '.']);
if (build.code !== 0) fail('镜像构建失败', build.out);
console.log('✓ 镜像构建成功');

// 2) 启动
run('docker', ['rm', '-f', CONTAINER]);
console.log(`启动容器 ${CONTAINER} …`);
const start = run('docker', [
    'run', '-d', '--name', CONTAINER,
    '-p', `${PORT}:8788`,
    '-e', 'IDLECLOUD_API_KEY=smoke-key',
    IMAGE,
]);
if (start.code !== 0) fail('容器启动失败', start.out);

let failed = false;
try {
    // 3) 等健康检查通过（最多 30 秒）
    let healthy = false;
    for (let i = 0; i < 30; i++) {
        const s = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER]);
        const status = s.out.trim();
        if (status === 'healthy') { healthy = true; break; }
        if (status === 'unhealthy') break;
        const running = run('docker', ['inspect', '--format', '{{.State.Running}}', CONTAINER]).out.trim();
        if (running !== 'true') break;
        sleep(1000);
    }

    if (!healthy) {
        const logs = run('docker', ['logs', CONTAINER]).out;
        fail('容器未达到 healthy 状态（很可能缺少模块或启动即崩溃）', logs);
    }
    console.log('✓ 容器健康检查通过（healthy）');

    // 4) 关键路由验证
    const checks = [
        { path: '/healthz', expect: 200, name: '健康检查' },
        { path: '/icon.png', expect: 200, name: '内置图标' },
        { path: '/user/subscription', expect: 401, name: '缺鉴权返回 401', auth: false },
    ];

    for (const c of checks) {
        const args = ['exec', CONTAINER, 'node', '-e',
            `fetch('http://127.0.0.1:8788${c.path}',${c.auth === false ? '{}' : "{headers:{Authorization:'Bearer x'}}"})` +
            `.then(r=>{console.log(r.status)}).catch(e=>{console.log('ERR')})`];
        const r = run('docker', args);
        const got = Number(r.out.trim().split('\n').pop());
        if (got !== c.expect) {
            console.error(`✗ ${c.name}: 期望 ${c.expect}，实际 ${got}`);
            failed = true;
        } else {
            console.log(`✓ ${c.name}（HTTP ${got}）`);
        }
    }

    // 5) 额度端点返回正确结构（验证 quota.js 已打包且映射生效）
    const q = run('docker', ['exec', CONTAINER, 'node', '-e',
        "fetch('http://127.0.0.1:8788/user/subscription',{headers:{Authorization:'Bearer x'}})" +
        ".then(r=>r.json()).then(d=>console.log(JSON.stringify({" +
        "tier:d.tier," +
        "daily:d.trainingStepsLeft&&d.trainingStepsLeft.fixedTrainingStepsLeft," +
        "percent:d.usage&&d.usage.percent," +
        "hasIdlecloud:!!d.idlecloud})))"]);
    try {
        const data = JSON.parse(q.out.trim().split('\n').pop());
        if (data.hasIdlecloud !== true || typeof data.percent !== 'number' || typeof data.daily !== 'number') {
            console.error(`✗ 额度端点结构异常: ${JSON.stringify(data)}`);
            failed = true;
        } else {
            console.log(`✓ 额度映射生效（每日剩余 ${data.daily}，V5 充能 ${data.percent}）`);
        }
    } catch {
        console.error(`✗ 额度端点无法解析: ${q.out.trim().slice(-200)}`);
        failed = true;
    }
} finally {
    run('docker', ['rm', '-f', CONTAINER]);
}

if (failed) process.exit(1);
console.log('\n镜像冒烟测试通过。');
