/**
 * 额度统计与 NovelAI 字段映射。
 *
 * 需求：
 *   1. NovelAI 的「训练步数」(trainingStepsLeft.fixedTrainingStepsLeft)
 *      -> IDLECLOUD 的「每日生图请求次数」；
 *   2. NovelAI 的「V5 充能 / Opus 生成额度」(usage.percent)
 *      -> IDLECLOUD 的「每周 V5 剩余次数」，剩余 67 次即返回 67。
 *
 * 为什么需要自己统计：
 *   IDLECLOUD 的 GET /api/user_info 只支持 **Session** 认证，Bearer API Key 读不到
 *   额度（实测返回 ACCOUNT_AUTH_REQUIRED）。因此本模块以「经过代理的成功生成」为
 *   口径统计，并在上游返回 NOVELAI_V5_WEEKLY_QUOTA_EXCEEDED 时用其权威的
 *   limit / remaining / reset_at 校正本地计数。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** 大图模式阈值：宽高乘积超过该值即进入大图队列。 */
export const BIG_IMAGE_PIXEL_LIMIT = 1048576;

/**
 * 「普通模式」步数上限，超过即视为大图（消耗大图点数、不占每日次数与 V5 周额度）。
 *
 * 默认 28：V5 普通模式上限同样是 28 步。
 * （IDLECLOUD 文档里「V5 为 23 步」的说法针对的是官方适配端点
 *  /api/ai/generate-image 的路由规则；本代理走通用端点 /api/generate_image，
 *  按 28 步判定。可用环境变量 NORMAL_STEPS_LIMIT 覆盖。）
 */
export const NORMAL_STEPS_LIMIT_DEFAULT = 28;

// ---------------------------------------------------------------------------
// 北京时间（UTC+8）工具
// ---------------------------------------------------------------------------

/** 当前北京时间所在日期的 `YYYY-MM-DD`。 */
export function beijingDateKey(now = Date.now()) {
    const d = new Date(now + BEIJING_OFFSET_MS);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/** 当前北京时间所在日期的 00:00 对应的 epoch 毫秒。 */
export function beijingMidnight(now = Date.now()) {
    const d = new Date(now + BEIJING_OFFSET_MS);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BEIJING_OFFSET_MS;
}

/** 下一个北京时间 00:00（每日额度重置时刻）。 */
export function nextBeijingMidnight(now = Date.now()) {
    return beijingMidnight(now) + DAY_MS;
}

// ---------------------------------------------------------------------------
// 大图判定
// ---------------------------------------------------------------------------

/**
 * 判断请求是否进入「大图模式」。
 * 依据 IDLECLOUD 文档：宽高乘积 > 1048576、步数超过普通模式上限，或显式启用
 * use_upscale_credits。大图请求不占用每日普通生成次数，也不计入 V5 周额度。
 *
 * @param {object} payload 转换后的通用端点请求体
 * @param {number} [normalStepsLimit] 普通模式步数上限，默认 28
 */
export function isBigImageRequest(payload = {}, normalStepsLimit = NORMAL_STEPS_LIMIT_DEFAULT) {
    if (payload.use_upscale_credits === true) return true;

    const w = Number(payload.width) || 0;
    const h = Number(payload.height) || 0;
    if (w > 0 && h > 0 && w * h > BIG_IMAGE_PIXEL_LIMIT) return true;

    const steps = Number(payload.steps);
    if (Number.isFinite(steps) && steps > normalStepsLimit) return true;

    return false;
}

/** 判断模型是否属于 NovelAI V5 家族（计入每周额度）。 */
export function isV5Model(model) {
    return /nai-diffusion-5/i.test(String(model || ''));
}

// ---------------------------------------------------------------------------
// 额度跟踪器
// ---------------------------------------------------------------------------

export class QuotaTracker {
    /**
     * @param {object} options
     * @param {string|null} options.dataFile 状态文件路径；null 表示仅内存（测试用）
     * @param {number} options.dailyLimit 每日普通生成次数上限
     * @param {number} options.v5WeeklyLimit 每周 V5 图片额度上限
     * @param {'remaining'|'used'} options.dailyValueMode 训练步数字段填「剩余」还是「已用」
     * @param {'count'|'ratio'} options.v5PercentMode V5 充能百分比口径：
     *        count = 剩余次数直接当百分比（剩余 67 次 -> 67，用户需求口径）；
     *        ratio = 剩余/上限 * 100
     * @param {(msg:string)=>void} [options.log]
     */
    constructor({
        dataFile = null,
        dailyLimit = 600,
        v5WeeklyLimit = 100,
        dailyValueMode = 'remaining',
        v5PercentMode = 'count',
        log = () => {},
    } = {}) {
        this.dataFile = dataFile;
        this.dailyLimit = Math.max(1, Math.trunc(dailyLimit));
        this.v5WeeklyLimit = Math.max(1, Math.trunc(v5WeeklyLimit));
        this.dailyValueMode = dailyValueMode === 'used' ? 'used' : 'remaining';
        this.v5PercentMode = v5PercentMode === 'ratio' ? 'ratio' : 'count';
        this.log = log;

        /** @type {{date: string, used: number}} */
        this.daily = { date: beijingDateKey(), used: 0 };
        /** @type {{cycleStart: number|null, used: number, limit: number}} */
        this.weekly = { cycleStart: null, used: 0, limit: this.v5WeeklyLimit };

        this.#load();
        this.#rollover();
    }

    // ---- 持久化 ----

    #load() {
        if (!this.dataFile) return;
        try {
            const raw = JSON.parse(readFileSync(this.dataFile, 'utf8'));
            if (raw && typeof raw === 'object') {
                if (raw.daily && typeof raw.daily.used === 'number' && typeof raw.daily.date === 'string') {
                    this.daily = { date: raw.daily.date, used: Math.max(0, Math.trunc(raw.daily.used)) };
                }
                if (raw.weekly && typeof raw.weekly.used === 'number') {
                    this.weekly = {
                        cycleStart: Number.isFinite(raw.weekly.cycleStart) ? raw.weekly.cycleStart : null,
                        used: Math.max(0, Math.trunc(raw.weekly.used)),
                        limit: Number.isFinite(raw.weekly.limit) ? Math.trunc(raw.weekly.limit) : this.v5WeeklyLimit,
                    };
                }
            }
        } catch (error) {
            if (error && error.code !== 'ENOENT') {
                this.log(`额度状态读取失败，将从零开始统计: ${error.message}`);
            }
        }
    }

    save() {
        if (!this.dataFile) return;
        try {
            mkdirSync(dirname(this.dataFile), { recursive: true });
            const payload = JSON.stringify({
                version: 1,
                daily: this.daily,
                weekly: this.weekly,
            });
            // 先写临时文件再原子重命名，避免写入中断产生半截 JSON
            const tmp = `${this.dataFile}.tmp`;
            writeFileSync(tmp, payload, 'utf8');
            renameSync(tmp, this.dataFile);
        } catch (error) {
            this.log(`额度状态写入失败（统计仍可用，但重启会丢失）: ${error.message}`);
        }
    }

    // ---- 周期滚动 ----

    #rollover(now = Date.now()) {
        // 每日额度：按北京时间自然日重置
        const today = beijingDateKey(now);
        if (this.daily.date !== today) {
            this.daily = { date: today, used: 0 };
        }

        // 每周 V5 额度：按「首次计入额度的 V5 生成所在日 00:00」起算的连续 7 天
        if (this.weekly.cycleStart !== null && now >= this.weekly.cycleStart + WEEK_MS) {
            this.weekly.cycleStart = null;
            this.weekly.used = 0;
        }
    }

    // ---- 记账 ----

    /**
     * 记录一次成功生成。
     * @param {object} info
     * @param {boolean} info.isV5 是否 V5 模型
     * @param {boolean} info.isBigImage 是否大图模式（大图不占普通日额度与 V5 周额度）
     */
    recordGeneration({ isV5 = false, isBigImage = false } = {}) {
        this.#rollover();
        // 大图消耗的是「大图点数」，既不占每日普通生成次数，也不计入 V5 周额度
        if (isBigImage) {
            this.save();
            return this.snapshot();
        }

        this.daily.used += 1;

        if (isV5) {
            if (this.weekly.cycleStart === null) {
                // 文档：以首次计入额度的 V5 生成当日的北京时间 00:00 建立周期
                this.weekly.cycleStart = beijingMidnight();
            }
            this.weekly.used += 1;
        }

        this.save();
        return this.snapshot();
    }

    /**
     * 用上游 429 的权威数据校正 V5 周额度。
     * 文档：额度不足时返回 success / pending / limit / remaining / reset_at。
     */
    applyV5QuotaError(info = {}) {
        const limit = Number(info.limit);
        const remaining = Number(info.remaining);
        if (Number.isFinite(limit) && limit > 0) {
            this.weekly.limit = Math.trunc(limit);
        }
        if (Number.isFinite(remaining)) {
            this.weekly.used = Math.max(0, this.weekly.limit - Math.trunc(remaining));
        } else {
            this.weekly.used = this.weekly.limit;
        }
        // 周期起点未知时，用 reset_at 反推（reset_at 为周期结束时刻）
        const resetAt = Date.parse(info.reset_at);
        if (Number.isFinite(resetAt) && this.weekly.cycleStart === null) {
            this.weekly.cycleStart = resetAt - WEEK_MS;
        }
        this.save();
        return this.snapshot();
    }

    // ---- 快照 ----

    /** 返回当前额度快照（含给 NovelAI 客户端用的派生值）。 */
    snapshot(now = Date.now()) {
        this.#rollover(now);

        const dailyRemaining = Math.max(0, this.dailyLimit - this.daily.used);
        const v5Limit = this.weekly.limit;
        const v5Remaining = Math.max(0, v5Limit - this.weekly.used);
        // 需求 2 的口径：剩余 67 次 -> 返回 67（剩余次数直接作为百分比）。
        // 也支持按比例换算（ratio），便于上限不是 100 的账号。
        const v5Percent = this.v5PercentMode === 'ratio'
            ? Math.max(0, Math.min(100, Math.round((v5Remaining / v5Limit) * 100)))
            : Math.max(0, v5Remaining);

        const v5ResetAt = this.weekly.cycleStart === null ? null : this.weekly.cycleStart + WEEK_MS;

        return {
            dailyUsed: this.daily.used,
            dailyLimit: this.dailyLimit,
            dailyRemaining,
            dailyValueMode: this.dailyValueMode,
            dailyResetAt: nextBeijingMidnight(now),
            v5Used: this.weekly.used,
            v5Limit,
            v5Remaining,
            v5Percent,
            v5PercentMode: this.v5PercentMode,
            v5Exhausted: v5Remaining <= 0,
            v5ResetAt,
        };
    }
}

// ---------------------------------------------------------------------------
// NovelAI /user/subscription 响应构造
// ---------------------------------------------------------------------------

/**
 * 把 IDLECLOUD 额度映射为 NovelAI 官方 /user/subscription 响应。
 *
 * 字段契约经 RP-Hub 实现（assets/js/core-utils.js resolveNaiOfficialAccount）核对：
 *   - 响应体**顶层**即 tier / active / expiresAt / trainingStepsLeft / usage
 *   - trainingStepsLeft.fixedTrainingStepsLeft 是「剩余训练步数」
 *   - usage.percent 是**剩余百分比**（官方文案 "N% of Opus Generations remaining"），
 *     不是已用量；isNegative 为真表示已用尽；timeUntilNextPercent 是「每回充 1% 所需秒数」
 *   - 官方条按 17.3 张/% 估算可出图数
 *   - 只有 nai-diffusion-5-* 消耗这条充能，V4.5 及更早不受影响
 */
export function buildNovelSubscription(quota, { tier = 3, now = Date.now() } = {}) {
    // 需求 1：训练步数字段承载 IDLECLOUD 的每日生图请求次数
    const dailyValue = quota.dailyValueMode === 'used' ? quota.dailyUsed : quota.dailyRemaining;

    return {
        tier,
        active: true,
        // NovelAI 使用秒级时间戳
        expiresAt: Math.floor((now + 365 * DAY_MS) / 1000),
        trainingStepsLeft: {
            fixedTrainingStepsLeft: dailyValue,
            purchasedTrainingSteps: 0,
        },
        // 需求 2：V5 充能 = 每周 V5 剩余次数（剩余 67 次 -> 67）
        usage: {
            percent: quota.v5Percent,
            isNegative: quota.v5Exhausted,
            timeUntilNextPercent: quota.v5ResetAt === null
                ? 0
                : Math.max(0, Math.floor((quota.v5ResetAt - now) / 1000)),
        },
        // 保持 false，让客户端的 Anlas Guard 生效（避免超额消耗）
        perks: {
            unlimitedImageGeneration: false,
        },
        // 便于排障：同时暴露原始口径（非 NovelAI 官方字段，客户端会忽略）
        idlecloud: {
            daily: {
                used: quota.dailyUsed,
                limit: quota.dailyLimit,
                remaining: quota.dailyRemaining,
                resets_at: new Date(quota.dailyResetAt).toISOString(),
            },
            v5_weekly: {
                used: quota.v5Used,
                limit: quota.v5Limit,
                remaining: quota.v5Remaining,
                percent: quota.v5Percent,
                resets_at: quota.v5ResetAt === null ? null : new Date(quota.v5ResetAt).toISOString(),
            },
        },
    };
}

/**
 * 构造 NovelAI /user/information 响应。
 * RP-Hub 从该端点读 trialImagesLeft / trialActionsLeft（注册赠送的试用张数）。
 * 这里把 IDLECLOUD 的每日剩余次数映射到试用张数，使客户端两处显示一致。
 */
export function buildNovelInformation(quota, { now = Date.now() } = {}) {
    return {
        trialImagesLeft: quota.dailyRemaining,
        trialActionsLeft: quota.dailyRemaining,
        // 非官方字段，仅供排障
        idlecloud: {
            daily_used: quota.dailyUsed,
            daily_limit: quota.dailyLimit,
            daily_remaining: quota.dailyRemaining,
            resets_at: new Date(quota.dailyResetAt).toISOString(),
            v5_weekly_remaining: quota.v5Remaining,
            v5_weekly_limit: quota.v5Limit,
            v5_weekly_percent: quota.v5Percent,
        },
        _generatedAt: new Date(now).toISOString(),
    };
}

/** 官方前端用的换算比例：1% 充能约等于 17.3 张图。 */
export const NAI_IMAGES_PER_PERCENT = 17.3;
