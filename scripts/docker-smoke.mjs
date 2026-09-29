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

// 2) 启动（挂载一个宿主属主为 root 的目录，复现 unraid appdata 的真实情况）
const { mkdtempSync, rmSync, statSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const dataDir = mkdtempSync(join(tmpdir(), 'nai-smoke-data-'));

run('docker', ['rm', '-f', CONTAINER]);
console.log(`启动容器 ${CONTAINER} …`);
const start = run('docker', [
    'run', '-d', '--name', CONTAINER,
    '-p', `${PORT}:8788`,
    '-v', `${dataDir}:/data`,
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

    // 6) 额度持久化：写一次状态 -> 重启 -> 计数必须还在。
    //    这一步专治「挂载目录属主不对导致写不进去，重启后额度重置」的问题。
    const beforeRestart = run('docker', ['exec', CONTAINER, 'node', '-e',
        "const fs=require('fs');const p=process.env.QUOTA_FILE||'/data/quota.json';" +
        "fs.writeFileSync(p, JSON.stringify({version:1,daily:{date:new Date(Date.now()+8*3600e3).toISOString().slice(0,10),used:42},weekly:{cycleStart:null,used:7,limit:100}}));" +
        "console.log(fs.existsSync(p)?'WROTE':'FAILED')"]);
    if (!beforeRestart.out.includes('WROTE')) {
        console.error('✗ 无法写入额度状态文件（挂载目录权限问题）');
        console.error(beforeRestart.out.trim().slice(-300));
        failed = true;
    } else {
        run('docker', ['restart', CONTAINER]);
        let ok = false;
        for (let i = 0; i < 30; i++) {
            const s = run('docker', ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER]);
            if (s.out.trim() === 'healthy') { ok = true; break; }
            sleep(1000);
        }
        if (!ok) {
            console.error('✗ 重启后容器未恢复 healthy');
            failed = true;
        } else {
            const after = run('docker', ['exec', CONTAINER, 'node', '-e',
                "fetch('http://127.0.0.1:8788/user/subscription',{headers:{Authorization:'Bearer x'}})" +
                ".then(r=>r.json()).then(d=>console.log(d.idlecloud.daily.used+'/'+d.idlecloud.v5_weekly.used))"]);
            const val = after.out.trim().split('\n').pop();
            if (val === '42/7') {
                console.log('✓ 额度状态持久化（重启后计数保留: 42/7）');
            } else {
                console.error(`✗ 额度状态未持久化：重启后读到 ${val}，期望 42/7`);
                failed = true;
            }
        }
    }
} finally {
    run('docker', ['rm', '-f', CONTAINER]);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

if (failed) process.exit(1);
console.log('\n镜像冒烟测试通过。');
