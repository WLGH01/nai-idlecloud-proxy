/**
 * NAI 官方请求 -> IDLECLOUD 通用生成端点(/api/generate_image) 的纯转换层。
 *
 * 设计约束：
 *  - 本文件不做任何网络 IO，全部为纯函数，便于单元测试与反向验证。
 *  - 客户端(酒馆等)始终以 NovelAI 官方契约交互；上游固定使用 IDLECLOUD 通用端点。
 */

const V5_MODEL_RE = /nai-diffusion-5/i;

/** 去掉 data URL 前缀，只保留裸 base64。 */
export function stripDataUrl(value) {
    if (typeof value !== 'string') return value;
    if (!value.startsWith('data:')) return value;
    const marker = ';base64,';
    const idx = value.indexOf(marker);
    return idx === -1 ? value : value.slice(idx + marker.length);
}

function isObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstNonEmptyString(...values) {
    for (const v of values) {
        if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
}

/**
 * 仅在值有意义时写入，避免向上游发送 null / undefined / 空数组触发参数校验失败。
 * positivePrompt 与 negativePrompt 是文档标注的必填字段，允许空字符串。
 */
function set(out, key, value, { allowEmptyString = false } = {}) {
    if (value === undefined || value === null) return;
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length === 0 && !allowEmptyString) return;
    if (Array.isArray(value) && value.length === 0) return;
    out[key] = value;
}

/** 归一化 base64 数组（逐项去 data URL 前缀）。 */
function mapBase64Array(value) {
    if (!Array.isArray(value)) return undefined;
    return value.map(stripDataUrl);
}

/**
 * NAI 官方 /ai/generate-image 请求体 -> IDLECLOUD /api/generate_image 请求体。
 *
 * @param {object} nai NAI 官方请求体 {input, model, action, parameters}
 * @param {object} [options]
 * @param {Record<string,string>} [options.modelMap] 模型名映射表（可选覆盖）
 * @returns {object} IDLECLOUD 通用端点请求体
 */
export function convertNaiToGeneral(nai, options = {}) {
    const body = isObject(nai) ? nai : {};
    const p = isObject(body.parameters) ? body.parameters : {};
    const out = {};

    // ---- 模型 ----
    const rawModel = firstNonEmptyString(body.model, 'nai-diffusion-4-5-full');
    const modelMap = isObject(options.modelMap) ? options.modelMap : {};
    out.model = modelMap[rawModel] || rawModel;

    // ---- 提示词：NAI 的 v4_prompt 是权威来源，input 作为回退 ----
    const v4Prompt = isObject(p.v4_prompt) ? p.v4_prompt : null;
    const v4Neg = isObject(p.v4_negative_prompt) ? p.v4_negative_prompt : null;
    const baseCaption = v4Prompt && isObject(v4Prompt.caption) ? v4Prompt.caption.base_caption : undefined;
    const negBaseCaption = v4Neg && isObject(v4Neg.caption) ? v4Neg.caption.base_caption : undefined;

    out.positivePrompt = firstNonEmptyString(baseCaption, body.input, '');
    out.negativePrompt = firstNonEmptyString(negBaseCaption, p.negative_prompt, '');

    // ---- 采样参数 ----
    set(out, 'width', p.width);
    set(out, 'height', p.height);
    set(out, 'scale', p.scale);
    set(out, 'steps', p.steps);
    set(out, 'sampler', p.sampler);
    set(out, 'noise_schedule', p.noise_schedule);
    // seed 为负或缺失时留空，由上游随机
    if (typeof p.seed === 'number' && Number.isFinite(p.seed) && p.seed >= 0) {
        out.seed = Math.trunc(p.seed);
    }
    set(out, 'promptGuidanceRescale', p.cfg_rescale ?? p.promptGuidanceRescale);

    // ---- 开关类（false 有意义，需显式传递） ----
    if (typeof p.sm === 'boolean') out.sm = p.sm;
    if (typeof p.sm_dyn === 'boolean') out.sm_dyn = p.sm_dyn;
    if (typeof p.autoSmea === 'boolean') out.autoSmea = p.autoSmea;
    if (typeof p.prefer_brownian === 'boolean') out.prefer_brownian = p.prefer_brownian;
    if (typeof p.deliberate_euler_ancestral_bug === 'boolean') {
        out.deliberate_euler_ancestral_bug = p.deliberate_euler_ancestral_bug;
    }
    if (typeof p.legacy === 'boolean') out.legacy = p.legacy;
    if (typeof p.legacy_uc === 'boolean') out.legacy_uc = p.legacy_uc;
    if (typeof p.legacy_v3_extend === 'boolean') out.legacy_v3_extend = p.legacy_v3_extend;
    if (typeof p.use_upscale_credits === 'boolean') out.use_upscale_credits = p.use_upscale_credits;

    // decrisp：NAI 用 dynamic_thresholding 表达
    if (typeof p.dynamic_thresholding === 'boolean') out.decrisp = p.dynamic_thresholding;
    else if (typeof p.decrisp === 'boolean') out.decrisp = p.decrisp;

    // variety：NAI 通过 skip_cfg_above_sigma 非空表达
    if (p.skip_cfg_above_sigma !== undefined && p.skip_cfg_above_sigma !== null) out.variety = true;
    else if (typeof p.variety === 'boolean') out.variety = p.variety;

    // ---- 图生图 ----
    const image = stripDataUrl(p.image);
    if (typeof image === 'string' && image.length > 0) {
        out.action = true;
        out.image = image;
        set(out, 'strength', p.strength);
        set(out, 'noise', p.noise);
    }

    // ---- 局部重绘 ----
    const mask = stripDataUrl(p.mask);
    if (typeof mask === 'string' && mask.length > 0) {
        out.mask = mask;
        set(out, 'inpaint_strength', p.inpaint_strength ?? p.inpaintImg2ImgStrength);
        if (typeof p.color_correct === 'boolean') out.color_correct = p.color_correct;
        if (typeof p.disabled_original_image === 'boolean') {
            out.disabled_original_image = p.disabled_original_image;
        }
    }

    // ---- 参考图（V3/V4） ----
    const refImages = mapBase64Array(p.reference_image_multiple);
    if (refImages && refImages.length) {
        out.reference_image_multiple = refImages;
        const refStrength = p.reference_strength_multiple;
        if (Array.isArray(refStrength) && refStrength.length) {
            out.reference_strength_multiple = refStrength;
        }
        const refInfo = p.reference_information_extracted_multiple;
        if (Array.isArray(refInfo) && refInfo.length) {
            out.reference_information_extracted_multiple = refInfo;
        }
    }

    // ---- 角色参考（Director Reference） ----
    // IDLECLOUD 只消费 *_images_cached，NAI 客户端发的是裸 base64 数组，需要包装。
    const directorRaw = p.director_reference_images_cached ?? p.director_reference_images;
    if (Array.isArray(directorRaw) && directorRaw.length) {
        out.director_reference_images_cached = directorRaw.map((item) => {
            if (isObject(item)) {
                const wrapped = { data: stripDataUrl(item.data) };
                if (typeof item.cache_secret_key === 'string' && item.cache_secret_key) {
                    wrapped.cache_secret_key = item.cache_secret_key;
                }
                return wrapped;
            }
            return { data: stripDataUrl(item) };
        });
        set(out, 'director_reference_descriptions', p.director_reference_descriptions);
        set(out, 'director_reference_strength_values', p.director_reference_strength_values);
        set(out, 'director_reference_secondary_strength_values', p.director_reference_secondary_strength_values);
        set(out, 'director_reference_information_extracted', p.director_reference_information_extracted);
    }

    // ---- 角色控制（V4/V5） ----
    const charCaptions = v4Prompt && isObject(v4Prompt.caption) ? v4Prompt.caption.char_captions : undefined;
    const negCharCaptions = v4Neg && isObject(v4Neg.caption) ? v4Neg.caption.char_captions : undefined;
    if (Array.isArray(charCaptions) && charCaptions.length) {
        out.v4_prompt_char_captions = charCaptions;
    }
    if (Array.isArray(negCharCaptions) && negCharCaptions.length) {
        out.v4_negative_prompt_char_captions = negCharCaptions;
    }

    if (Array.isArray(p.characterPrompts) && p.characterPrompts.length) {
        const isV5 = V5_MODEL_RE.test(out.model);
        out.characterPrompts = p.characterPrompts.map((item) => {
            if (!isObject(item)) return item;
            // V5 文档要求每个启用角色显式带 enabled: true
            if (isV5 && item.enabled === undefined) return { ...item, enabled: true };
            return item;
        });
    }

    if (typeof p.use_coords === 'boolean') out.use_coords = p.use_coords;

    return out;
}

/**
 * NAI 官方 /ai/augment-image（上色/情绪/线稿等）-> IDLECLOUD 通用端点图像工具请求体。
 */
export function convertAugmentToGeneral(nai, options = {}) {
    const body = isObject(nai) ? nai : {};
    const out = {};
    const reqType = firstNonEmptyString(body.req_type, body.reqType);
    if (reqType) out.req_type = reqType;
    set(out, 'width', body.width);
    set(out, 'height', body.height);
    set(out, 'prompt', body.prompt);
    set(out, 'defry', body.defry);
    const image = stripDataUrl(body.image);
    if (typeof image === 'string' && image.length > 0) out.image = image;
    // 图像工具端点不强制 model；若客户端给了就透传，否则用配置的兜底模型
    const model = firstNonEmptyString(body.model, options.augmentModel || '');
    if (model) out.model = model;
    return out;
}

// ---------------------------------------------------------------------------
// ZIP 打包：NovelAI 官方 /ai/generate-image 返回 ZIP，客户端按 ZIP 解包取 PNG。
// IDLECLOUD 通用端点返回的是图片 URL，因此这里需要重新打包以保持客户端契约不变。
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

export function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/**
 * 生成一个 STORE（不压缩）方式的 ZIP。PNG 本身已压缩，STORE 足够且实现简单。
 * @param {{name: string, data: Buffer|Uint8Array}[]} entries
 * @returns {Buffer}
 */
export function createZip(entries) {
    const localChunks = [];
    const centralChunks = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
        const crc = crc32(data);

        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // flag: UTF-8 文件名
        local.writeUInt16LE(0, 8); // method: store
        local.writeUInt16LE(0, 10); // mod time
        local.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        localChunks.push(local, nameBuf, data);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4); // version made by
        cd.writeUInt16LE(20, 6); // version needed
        cd.writeUInt16LE(0x0800, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(0, 12);
        cd.writeUInt16LE(0x21, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE(0, 38);
        cd.writeUInt32LE(offset, 42);
        centralChunks.push(cd, nameBuf);

        offset += local.length + nameBuf.length + data.length;
    }

    const central = Buffer.concat(centralChunks);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localChunks, central, end]);
}

// ---------------------------------------------------------------------------
// multipart/form-data 最小解析：NAI 官方兼容 multipart，其中 request 字段是官方 JSON。
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buffer 完整请求体
 * @param {string} boundary multipart 分隔符
 * @returns {{fields: Record<string,string>, files: Record<string,{filename:string,data:Buffer}>}}
 */
export function parseMultipart(buffer, boundary) {
    const fields = {};
    const files = {};
    if (!boundary) return { fields, files };

    const delim = Buffer.from(`--${boundary}`);
    let index = buffer.indexOf(delim);
    if (index === -1) return { fields, files };

    while (index !== -1) {
        let start = index + delim.length;
        // 结束标记 --boundary--
        if (buffer.slice(start, start + 2).toString() === '--') break;
        // 跳过 CRLF
        if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;

        const headerEnd = buffer.indexOf('\r\n\r\n', start);
        if (headerEnd === -1) break;
        const rawHeaders = buffer.slice(start, headerEnd).toString('utf8');
        const bodyStart = headerEnd + 4;

        const nextDelim = buffer.indexOf(delim, bodyStart);
        if (nextDelim === -1) break;
        // 去掉尾部的 CRLF
        let bodyEnd = nextDelim;
        if (buffer.slice(bodyEnd - 2, bodyEnd).toString() === '\r\n') bodyEnd -= 2;
        const data = buffer.slice(bodyStart, bodyEnd);

        const nameMatch = /name="([^"]*)"/i.exec(rawHeaders);
        const fileMatch = /filename="([^"]*)"/i.exec(rawHeaders);
        if (nameMatch) {
            const name = nameMatch[1];
            if (fileMatch) {
                files[name] = { filename: fileMatch[1], data };
            } else {
                fields[name] = data.toString('utf8');
            }
        }

        index = nextDelim;
    }

    return { fields, files };
}
