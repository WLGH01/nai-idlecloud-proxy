/**
 * 变异测试（反向验证）：故意破坏关键实现，确认测试会变红。
 * 若某个变异没有导致任何测试失败，说明对应断言缺乏鉴别力。
 *
 * 用法: node scripts/mutation.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
    {
        name: '破坏鉴权替换：忽略配置的 IDLECLOUD API Key，直接用客户端 token',
        file: 'server.js',
        from: `        if (config.apiKey) return config.apiKey;
        if (!config.authPassthrough) return '';`,
        to: `        if (false && config.apiKey) return config.apiKey;
        if (!config.authPassthrough) return '';`,
        expectPattern: '鉴权替换',
    },
    {
        name: '破坏 base64 前缀剥离：image 不去 data URL 前缀',
        file: 'convert.js',
        from: `    const image = stripDataUrl(p.image);
    if (typeof image === 'string' && image.length > 0) {
        out.action = true;`,
        to: `    const image = p.image;
    if (typeof image === 'string' && image.length > 0) {
        out.action = true;`,
        expectPattern: '图生图',
    },
    {
        name: '破坏布尔开关：false 被当作空值丢弃',
        file: 'convert.js',
        from: `    if (typeof p.sm === 'boolean') out.sm = p.sm;`,
        to: `    if (p.sm) out.sm = p.sm;`,
        expectPattern: '布尔开关',
    },
    {
        name: '破坏 ZIP：不写入 CRC 校验值',
        file: 'convert.js',
        from: `        local.writeUInt32LE(crc, 14);`,
        to: `        local.writeUInt32LE(0, 14);`,
        expectPattern: 'createZip',
    },
    {
        name: '破坏 V5 交付校验：跳过 SHA-256 比对',
        file: 'server.js',
        from: `        if (typeof delivery.sha256 === 'string' && delivery.sha256 && delivery.sha256 !== sha256) {`,
        to: `        if (false && typeof delivery.sha256 === 'string' && delivery.sha256 && delivery.sha256 !== sha256) {`,
        expectPattern: 'SHA-256',
    },
    {
        name: '破坏上游失败上报：忽略 failed 状态继续轮询',
        file: 'server.js',
        from: `            if (data.status === 'failed') {
                throw new UpstreamError(500, data.error || '上游生成失败', JSON.stringify(data).slice(0, 300));
            }`,
        to: `            if (false && data.status === 'failed') {
                throw new UpstreamError(500, data.error || '上游生成失败', JSON.stringify(data).slice(0, 300));
            }`,
        expectPattern: 'failed',
    },
    {
        name: '破坏额度映射：训练步数字段写死为 0（不再反映每日次数）',
        file: 'quota.js',
        from: `    const dailyValue = quota.dailyValueMode === 'used' ? quota.dailyUsed : quota.dailyRemaining;`,
        to: `    const dailyValue = 0;`,
        expectPattern: '训练步数|每日剩余|每日次数',
    },
    {
        name: '破坏 V5 充能：percent 写死为 100（不再反映每周剩余次数）',
        file: 'quota.js',
        from: `        usage: {
            percent: quota.v5Percent,`,
        to: `        usage: {
            percent: 100,`,
        expectPattern: 'V5 充能',
    },
    {
        name: '破坏 V5 充能口径：把「剩余」当成「已用」',
        file: 'quota.js',
        from: `        const v5Percent = this.v5PercentMode === 'ratio'
            ? Math.max(0, Math.min(100, Math.round((v5Remaining / v5Limit) * 100)))
            : Math.max(0, v5Remaining);`,
        to: `        const v5Percent = this.weekly.used;`,
        expectPattern: '充能',
    },
    {
        name: '破坏大图判定：忽略宽高乘积上限（大图被当成普通生成扣额度）',
        file: 'quota.js',
        from: `    if (w > 0 && h > 0 && w * h > BIG_IMAGE_PIXEL_LIMIT) return true;`,
        to: `    if (false && w > 0 && h > 0 && w * h > BIG_IMAGE_PIXEL_LIMIT) return true;`,
        expectPattern: '大图',
    },
    {
        name: '破坏大图判定：把 28 步误判为大图（用户明确指出的错误）',
        file: 'quota.js',
        from: `export const NORMAL_STEPS_LIMIT_DEFAULT = 28;`,
        to: `export const NORMAL_STEPS_LIMIT_DEFAULT = 23;`,
        expectPattern: '大图',
    },
    {
        name: '破坏 V5 记账：非 V5 模型也扣减每周额度',
        file: 'quota.js',
        from: `        if (isV5) {
            if (this.weekly.cycleStart === null) {`,
        to: `        if (true) {
            if (this.weekly.cycleStart === null) {`,
        expectPattern: 'V5',
    },
    {
        name: '破坏失败不扣额度：生成失败也记账',
        file: 'server.js',
        from: `        const png = await queue.run(() => submitAndPoll(payload, apiKey, 'generate-image'));

        // 生成成功后才记账：大图走大图点数，不占每日次数与 V5 周额度
        const snap = quota.recordGeneration({ isV5, isBigImage });`,
        to: `        const snap = quota.recordGeneration({ isV5, isBigImage });
        const png = await queue.run(() => submitAndPoll(payload, apiKey, 'generate-image'));`,
        expectPattern: '失败',
    },
    {
        name: '破坏 429 校正：忽略上游 V5 额度数据',
        file: 'server.js',
        from: `            const quotaInfo = extractV5QuotaError(submitText);`,
        to: `            const quotaInfo = null;`,
        expectPattern: '429',
    },
];

let allGood = true;

for (const m of MUTATIONS) {
    const path = join(root, m.file);
    const original = readFileSync(path, 'utf8');

    if (!original.includes(m.from)) {
        console.log(`✗ [${m.name}] 变异锚点未找到，脚本需更新`);
        allGood = false;
        continue;
    }

    writeFileSync(path, original.replace(m.from, m.to), 'utf8');

    const result = spawnSync(
        process.execPath,
        ['--test', '--test-name-pattern', m.expectPattern, 'test/convert.test.js', 'test/server.test.js'],
        { cwd: root, encoding: 'utf8' },
    );

    writeFileSync(path, original, 'utf8');

    const caught = result.status !== 0;
    const tail = (result.stdout || '').split('\n').filter((l) => /^# (pass|fail)/.test(l)).join(' | ');

    if (caught) {
        console.log(`✓ 变异被捕获 [${m.name}]  ->  ${tail}`);
    } else {
        console.log(`✗ 变异未被捕获 [${m.name}]  ->  测试仍然全绿，断言缺乏鉴别力`);
        allGood = false;
    }
}

console.log(allGood ? '\n反向验证通过：所有关键变异都被测试捕获。' : '\n反向验证失败：存在未被捕获的变异。');
process.exit(allGood ? 0 : 1);
