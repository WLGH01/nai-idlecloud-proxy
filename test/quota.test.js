import test from 'node:test';
import assert from 'node:assert/strict';

import {
    QuotaTracker,
    buildNovelSubscription,
    buildNovelInformation,
    beijingDateKey,
    beijingMidnight,
    nextBeijingMidnight,
    isBigImageRequest,
    isV5Model,
    BIG_IMAGE_PIXEL_LIMIT,
} from '../quota.js';

// ---------------------------------------------------------------------------
// 时间工具
// ---------------------------------------------------------------------------

test('beijingDateKey 使用 UTC+8 而非 UTC', () => {
    // 2026-01-01T15:00:00Z = 北京时间 2026-01-01 23:00
    assert.equal(beijingDateKey(Date.parse('2026-01-01T15:00:00Z')), '2026-01-01');
    // 2026-01-01T16:00:00Z = 北京时间 2026-01-02 00:00（跨日）
    assert.equal(beijingDateKey(Date.parse('2026-01-01T16:00:00Z')), '2026-01-02');
});

test('beijingMidnight 与 nextBeijingMidnight 相差 24 小时', () => {
    const now = Date.parse('2026-05-20T03:00:00Z');
    const mid = beijingMidnight(now);
    const next = nextBeijingMidnight(now);
    assert.equal(next - mid, 24 * 60 * 60 * 1000);
    assert.equal(beijingDateKey(mid), '2026-05-20');
});

// ---------------------------------------------------------------------------
// 大图判定
// ---------------------------------------------------------------------------

test('isBigImageRequest：宽高乘积超限算大图', () => {
    assert.equal(isBigImageRequest({ width: 1024, height: 1024 }), false); // 恰好 1048576
    assert.equal(isBigImageRequest({ width: 1025, height: 1024 }), true);
    assert.equal(isBigImageRequest({ width: 832, height: 1216 }), false); // 1011712
});

test('isBigImageRequest：步数超普通模式上限（28）才算大图', () => {
    assert.equal(isBigImageRequest({ model: 'nai-diffusion-5-full', steps: 28 }), false, '28 步是普通模式');
    assert.equal(isBigImageRequest({ model: 'nai-diffusion-5-full', steps: 29 }), true, '29 步进入大图');
    // V4.5 同样以 28 为界
    assert.equal(isBigImageRequest({ model: 'nai-diffusion-4-5-full', steps: 28 }), false);
    assert.equal(isBigImageRequest({ model: 'nai-diffusion-4-5-full', steps: 29 }), true);
});

test('isBigImageRequest：普通模式步数上限可覆盖', () => {
    assert.equal(isBigImageRequest({ steps: 30 }, 40), false, '自定义上限 40 时 30 步仍是普通模式');
    assert.equal(isBigImageRequest({ steps: 41 }, 40), true);
});

test('isBigImageRequest：显式 use_upscale_credits 算大图', () => {
    assert.equal(isBigImageRequest({ width: 512, height: 512, use_upscale_credits: true }), true);
});

test('isV5Model 只认 V5 家族', () => {
    assert.equal(isV5Model('nai-diffusion-5-full'), true);
    assert.equal(isV5Model('nai-diffusion-5-curated'), true);
    assert.equal(isV5Model('nai-diffusion-4-5-full'), false);
    assert.equal(isV5Model('nai-diffusion-3'), false);
});

// ---------------------------------------------------------------------------
// 额度记账
// ---------------------------------------------------------------------------

test('recordGeneration：普通生成同时增加每日与 V5 计数', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100 });
    q.recordGeneration({ isV5: true, isBigImage: false });
    const snap = q.snapshot();
    assert.equal(snap.dailyUsed, 1);
    assert.equal(snap.dailyRemaining, 599);
    assert.equal(snap.v5Used, 1);
    assert.equal(snap.v5Remaining, 99);
});

test('recordGeneration：非 V5 模型不消耗 V5 周额度', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100 });
    q.recordGeneration({ isV5: false, isBigImage: false });
    const snap = q.snapshot();
    assert.equal(snap.dailyUsed, 1);
    assert.equal(snap.v5Used, 0, 'V4.5 及更早不受充能条影响');
    assert.equal(snap.v5Remaining, 100);
});

test('recordGeneration：大图不占每日次数，也不占 V5 周额度', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100 });
    q.recordGeneration({ isV5: true, isBigImage: true });
    const snap = q.snapshot();
    assert.equal(snap.dailyUsed, 0, '大图消耗大图点数，不占每日普通生成次数');
    assert.equal(snap.v5Used, 0, '大图不计入 V5 周额度');
});

test('每日额度跨北京时间零点重置', () => {
    const q = new QuotaTracker({ dailyLimit: 10, v5WeeklyLimit: 100 });
    q.recordGeneration({ isV5: false });
    assert.equal(q.snapshot().dailyUsed, 1);

    // 伪造到次日：直接改内部日期，再触发滚动
    q.daily = { date: '1970-01-01', used: 5 };
    const snap = q.snapshot();
    assert.equal(snap.dailyUsed, 0, '跨日应清零');
    assert.equal(snap.dailyRemaining, 10);
});

test('每日额度用尽时 remaining 不为负', () => {
    const q = new QuotaTracker({ dailyLimit: 2, v5WeeklyLimit: 100 });
    for (let i = 0; i < 5; i++) q.recordGeneration({ isV5: false });
    const snap = q.snapshot();
    assert.equal(snap.dailyRemaining, 0);
    assert.equal(snap.dailyUsed, 5);
});

// ---------------------------------------------------------------------------
// V5 充能口径（用户需求核心）
// ---------------------------------------------------------------------------

test('V5 充能：剩余 67 次直接返回 67（count 口径）', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count' });
    for (let i = 0; i < 33; i++) q.recordGeneration({ isV5: true });
    const snap = q.snapshot();
    assert.equal(snap.v5Remaining, 67);
    assert.equal(snap.v5Percent, 67, '剩余 67 次应返回 67');
});

test('V5 充能：ratio 口径按上限换算百分比', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'ratio' });
    for (let i = 0; i < 33; i++) q.recordGeneration({ isV5: true });
    assert.equal(q.snapshot().v5Percent, 67);
});

test('V5 充能：上限非 100 时两种口径结果不同（证明口径真的生效）', () => {
    const count = new QuotaTracker({ v5WeeklyLimit: 200, v5PercentMode: 'count' });
    const ratio = new QuotaTracker({ v5WeeklyLimit: 200, v5PercentMode: 'ratio' });
    for (let i = 0; i < 67; i++) {
        count.recordGeneration({ isV5: true });
        ratio.recordGeneration({ isV5: true });
    }
    assert.equal(count.snapshot().v5Percent, 133, 'count：剩余 133 次');
    assert.equal(ratio.snapshot().v5Percent, 67, 'ratio：133/200 -> 67%');
});

test('V5 充能用尽时 isNegative 为 true（官方语义：透支标记）', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 2, v5PercentMode: 'ratio' });
    q.recordGeneration({ isV5: true });
    q.recordGeneration({ isV5: true });
    const snap = q.snapshot();
    assert.equal(snap.v5Remaining, 0);
    assert.equal(snap.v5Exhausted, true);
    assert.equal(snap.v5Percent, 0);
});

test('V5 周期在首次计入额度的生成后建立，7 天后重置', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 100, v5PercentMode: 'count' });
    assert.equal(q.snapshot().v5ResetAt, null, '未开始周期时无重置时间');

    q.recordGeneration({ isV5: true });
    const snap = q.snapshot();
    assert.ok(snap.v5ResetAt > Date.now(), '周期开始后应有重置时间');
    assert.equal(snap.v5ResetAt - q.weekly.cycleStart, 7 * 24 * 60 * 60 * 1000);

    // 伪造周期已过期
    q.weekly.cycleStart = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const after = q.snapshot();
    assert.equal(after.v5Used, 0, '超过 7 天应重置');
    assert.equal(after.v5Remaining, 100);
});

test('applyV5QuotaError 用上游 429 数据校正本地计数', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 100, v5PercentMode: 'count' });
    q.recordGeneration({ isV5: true });
    assert.equal(q.snapshot().v5Remaining, 99);

    // 上游说：上限 70，剩余 0
    const snap = q.applyV5QuotaError({ limit: 70, remaining: 0 });
    assert.equal(snap.v5Limit, 70);
    assert.equal(snap.v5Remaining, 0);
    assert.equal(snap.v5Used, 70);
});

test('applyV5QuotaError 缺 remaining 时视为已用尽', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 100 });
    const snap = q.applyV5QuotaError({ limit: 70 });
    assert.equal(snap.v5Remaining, 0);
});

// ---------------------------------------------------------------------------
// NovelAI 响应映射（用户需求核心）
// ---------------------------------------------------------------------------

test('需求 1：训练步数字段返回 IDLECLOUD 每日剩余次数', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100 });
    for (let i = 0; i < 150; i++) q.recordGeneration({ isV5: false });

    const sub = buildNovelSubscription(q.snapshot());
    // 契约来自 RP-Hub resolveNaiOfficialAccount 与 SillyTavern getNovelAnlas
    assert.equal(sub.trainingStepsLeft.fixedTrainingStepsLeft, 450);
    assert.equal(sub.trainingStepsLeft.purchasedTrainingSteps, 0);
});

test('需求 1：dailyValueMode=used 时返回已用次数', () => {
    const q = new QuotaTracker({ dailyLimit: 600, dailyValueMode: 'used' });
    for (let i = 0; i < 150; i++) q.recordGeneration({ isV5: false });
    const sub = buildNovelSubscription(q.snapshot());
    assert.equal(sub.trainingStepsLeft.fixedTrainingStepsLeft, 150);
});

test('需求 2：V5 充能 usage.percent 返回每周剩余次数（剩余 67 -> 67）', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 100, v5PercentMode: 'count' });
    for (let i = 0; i < 33; i++) q.recordGeneration({ isV5: true });

    const sub = buildNovelSubscription(q.snapshot());
    assert.equal(sub.usage.percent, 67, '剩余 67 次应返回 67');
    assert.equal(sub.usage.isNegative, false);
    assert.equal(typeof sub.usage.timeUntilNextPercent, 'number');
});

test('usage.percent 是「剩余量」而非已用量（官方语义）', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 100, v5PercentMode: 'count' });
    for (let i = 0; i < 80; i++) q.recordGeneration({ isV5: true });
    const sub = buildNovelSubscription(q.snapshot());
    // 已用 80，剩余 20 —— percent 必须是 20 而不是 80
    assert.equal(sub.usage.percent, 20);
});

test('响应为 NovelAI 顶层结构，tier 为 Opus 才带充能语义', () => {
    const q = new QuotaTracker({ v5WeeklyLimit: 100 });
    const sub = buildNovelSubscription(q.snapshot(), { tier: 3 });
    assert.equal(sub.tier, 3);
    assert.equal(sub.active, true);
    assert.ok(sub.expiresAt > Date.now() / 1000, 'expiresAt 为秒级时间戳且在未来');
    assert.equal(sub.perks.unlimitedImageGeneration, false);
    assert.ok(sub.usage, 'Opus 应返回 usage');
});

test('unlimitedImageGeneration 保持 false，让客户端 Anlas Guard 生效', () => {
    const q = new QuotaTracker({});
    assert.equal(buildNovelSubscription(q.snapshot()).perks.unlimitedImageGeneration, false);
});

test('buildNovelInformation 把每日剩余映射到试用张数', () => {
    const q = new QuotaTracker({ dailyLimit: 600 });
    for (let i = 0; i < 100; i++) q.recordGeneration({ isV5: false });
    const info = buildNovelInformation(q.snapshot());
    assert.equal(info.trialImagesLeft, 500);
    assert.equal(info.trialActionsLeft, 500);
});

test('idlecloud 排障字段同时暴露每日与每周口径', () => {
    const q = new QuotaTracker({ dailyLimit: 600, v5WeeklyLimit: 100, v5PercentMode: 'count' });
    q.recordGeneration({ isV5: true });
    const sub = buildNovelSubscription(q.snapshot());
    assert.equal(sub.idlecloud.daily.used, 1);
    assert.equal(sub.idlecloud.daily.remaining, 599);
    assert.equal(sub.idlecloud.v5_weekly.used, 1);
    assert.equal(sub.idlecloud.v5_weekly.remaining, 99);
    assert.equal(sub.idlecloud.v5_weekly.percent, 99);
});

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

test('持久化：写入后新实例能读回计数', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'quota-test-'));
    const file = join(dir, 'quota.json');

    try {
        const a = new QuotaTracker({ dataFile: file, dailyLimit: 600, v5WeeklyLimit: 100 });
        a.recordGeneration({ isV5: true });
        a.recordGeneration({ isV5: false });
        assert.equal(a.snapshot().dailyUsed, 2);

        const b = new QuotaTracker({ dataFile: file, dailyLimit: 600, v5WeeklyLimit: 100 });
        const snap = b.snapshot();
        assert.equal(snap.dailyUsed, 2, '重启后应读回计数');
        assert.equal(snap.v5Used, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('持久化：文件损坏时不崩溃，从零开始统计', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'quota-bad-'));
    const file = join(dir, 'quota.json');
    writeFileSync(file, '{ 这不是 JSON', 'utf8');

    try {
        const warnings = [];
        const q = new QuotaTracker({ dataFile: file, dailyLimit: 600, log: (m) => warnings.push(m) });
        assert.equal(q.snapshot().dailyUsed, 0);
        assert.ok(warnings.length > 0, '应记录一条警告');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('dataFile 为 null 时纯内存工作（不写盘）', () => {
    const q = new QuotaTracker({ dataFile: null, dailyLimit: 10 });
    q.recordGeneration({ isV5: false });
    assert.equal(q.snapshot().dailyUsed, 1);
});
