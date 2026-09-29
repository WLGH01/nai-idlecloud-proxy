import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';

import {
    convertNaiToGeneral,
    convertAugmentToGeneral,
    createZip,
    crc32,
    parseMultipart,
    stripDataUrl,
} from '../convert.js';

test('stripDataUrl 去掉 data URL 前缀', () => {
    assert.equal(stripDataUrl('data:image/png;base64,AAAA'), 'AAAA');
    assert.equal(stripDataUrl('AAAA'), 'AAAA');
    assert.equal(stripDataUrl(undefined), undefined);
});

test('基础文生图：input/parameters 映射到 positivePrompt/negativePrompt', () => {
    const out = convertNaiToGeneral({
        action: 'generate',
        input: '1girl, solo',
        model: 'nai-diffusion-4-5-full',
        parameters: {
            width: 832,
            height: 1216,
            scale: 5,
            steps: 28,
            sampler: 'k_euler',
            noise_schedule: 'karras',
            seed: 1234,
            negative_prompt: 'lowres',
            n_samples: 1,
        },
    });

    assert.equal(out.model, 'nai-diffusion-4-5-full');
    assert.equal(out.positivePrompt, '1girl, solo');
    assert.equal(out.negativePrompt, 'lowres');
    assert.equal(out.width, 832);
    assert.equal(out.height, 1216);
    assert.equal(out.steps, 28);
    assert.equal(out.scale, 5);
    assert.equal(out.sampler, 'k_euler');
    assert.equal(out.noise_schedule, 'karras');
    assert.equal(out.seed, 1234);
    // 不应把 NAI 专有字段透传给通用端点
    assert.equal(out.n_samples, undefined);
    assert.equal(out.action, undefined);
    assert.equal(out.params_version, undefined);
});

test('v4_prompt 的 base_caption 优先于 input', () => {
    const out = convertNaiToGeneral({
        input: '旧输入',
        model: 'nai-diffusion-4-5-full',
        parameters: {
            v4_prompt: { caption: { base_caption: '权威提示词', char_captions: [] }, use_coords: false, use_order: true },
            v4_negative_prompt: { caption: { base_caption: '权威负面', char_captions: [] } },
            negative_prompt: '旧负面',
        },
    });
    assert.equal(out.positivePrompt, '权威提示词');
    assert.equal(out.negativePrompt, '权威负面');
});

test('seed 为负或缺失时不发送 seed（由上游随机）', () => {
    const negative = convertNaiToGeneral({ model: 'nai-diffusion-4-5-full', parameters: { seed: -1 } });
    assert.equal('seed' in negative, false);

    const missing = convertNaiToGeneral({ model: 'nai-diffusion-4-5-full', parameters: {} });
    assert.equal('seed' in missing, false);

    const zero = convertNaiToGeneral({ model: 'nai-diffusion-4-5-full', parameters: { seed: 0 } });
    assert.equal(zero.seed, 0);
});

test('布尔开关 false 必须保留（不能被当成空值丢弃）', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: { sm: false, sm_dyn: false, legacy: false, autoSmea: false },
    });
    assert.equal(out.sm, false);
    assert.equal(out.sm_dyn, false);
    assert.equal(out.legacy, false);
    assert.equal(out.autoSmea, false);
});

test('dynamic_thresholding 映射为 decrisp，skip_cfg_above_sigma 映射为 variety', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: { dynamic_thresholding: true, skip_cfg_above_sigma: 19 },
    });
    assert.equal(out.decrisp, true);
    assert.equal(out.variety, true);

    const off = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: { dynamic_thresholding: false, skip_cfg_above_sigma: null },
    });
    assert.equal(off.decrisp, false);
    assert.equal(off.variety, undefined);
});

test('图生图：image 去前缀并设置 action=true', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: { image: 'data:image/png;base64,QUJD', strength: 0.7, noise: 0.1 },
    });
    assert.equal(out.action, true);
    assert.equal(out.image, 'QUJD');
    assert.equal(out.strength, 0.7);
    assert.equal(out.noise, 0.1);
});

test('局部重绘：mask 触发 inpaint 字段并透传强度', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-3',
        parameters: {
            image: 'QUJD',
            mask: 'data:image/png;base64,TUFTSw==',
            inpaintImg2ImgStrength: 0.85,
            color_correct: true,
        },
    });
    assert.equal(out.mask, 'TUFTSw==');
    assert.equal(out.inpaint_strength, 0.85);
    assert.equal(out.color_correct, true);
});

test('参考图数组去前缀并保留强度/信息提取', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-full',
        parameters: {
            reference_image_multiple: ['data:image/png;base64,QUJD', 'REVG'],
            reference_strength_multiple: [0.6, 0.75],
            reference_information_extracted_multiple: [1.0, 0.5],
        },
    });
    assert.deepEqual(out.reference_image_multiple, ['QUJD', 'REVG']);
    assert.deepEqual(out.reference_strength_multiple, [0.6, 0.75]);
    assert.deepEqual(out.reference_information_extracted_multiple, [1.0, 0.5]);
});

test('角色参考：裸 base64 数组被包装为 {data}', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: {
            director_reference_images: ['QUJD', 'REVG'],
            director_reference_descriptions: ['character&style', 'character'],
            director_reference_strength_values: [0.6, 0.7],
        },
    });
    assert.deepEqual(out.director_reference_images_cached, [{ data: 'QUJD' }, { data: 'REVG' }]);
    assert.deepEqual(out.director_reference_descriptions, ['character&style', 'character']);
});

test('角色参考：已带 data 的对象保持结构，旧字段名不再发送', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: {
            director_reference_images_cached: [
                { cache_secret_key: 'k1', data: 'data:image/png;base64,QUJD' },
            ],
        },
    });
    assert.deepEqual(out.director_reference_images_cached, [{ cache_secret_key: 'k1', data: 'QUJD' }]);
    assert.equal(out.director_reference_images, undefined);
});

test('V5 模型：characterPrompts 自动补 enabled=true', () => {
    const v5 = convertNaiToGeneral({
        model: 'nai-diffusion-5-full',
        parameters: { characterPrompts: [{ prompt: 'a', uc: 'b', center: { x: 0.1, y: 0.1 } }] },
    });
    assert.equal(v5.characterPrompts[0].enabled, true);

    const v4 = convertNaiToGeneral({
        model: 'nai-diffusion-4-full',
        parameters: { characterPrompts: [{ prompt: 'a', uc: 'b', center: { x: 0.1, y: 0.1 } }] },
    });
    assert.equal(v4.characterPrompts[0].enabled, undefined);
});

test('characterPrompts 已显式 enabled=false 时不被覆盖', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-5-full',
        parameters: { characterPrompts: [{ prompt: 'a', uc: 'b', enabled: false }] },
    });
    assert.equal(out.characterPrompts[0].enabled, false);
});

test('空数组与 null 不被发送，避免上游参数校验失败', () => {
    const out = convertNaiToGeneral({
        model: 'nai-diffusion-4-5-full',
        parameters: {
            reference_image_multiple: [],
            characterPrompts: [],
            skip_cfg_above_sigma: null,
            promptGuidanceRescale: null,
        },
    });
    assert.equal(out.reference_image_multiple, undefined);
    assert.equal(out.characterPrompts, undefined);
    assert.equal(out.variety, undefined);
    assert.equal(out.promptGuidanceRescale, undefined);
});

test('缺失 model 时使用默认模型', () => {
    const out = convertNaiToGeneral({ input: 'x', parameters: {} });
    assert.equal(out.model, 'nai-diffusion-4-5-full');
});

test('modelMap 可覆盖模型名', () => {
    const out = convertNaiToGeneral(
        { model: 'nai-diffusion-4-full', parameters: {} },
        { modelMap: { 'nai-diffusion-4-full': 'nai-diffusion-4-5-full' } },
    );
    assert.equal(out.model, 'nai-diffusion-4-5-full');
});

test('positivePrompt/negativePrompt 允许空字符串（上游必填）', () => {
    const out = convertNaiToGeneral({ model: 'nai-diffusion-4-5-full', parameters: {} });
    assert.equal(out.positivePrompt, '');
    assert.equal(out.negativePrompt, '');
});

test('非对象输入不抛异常', () => {
    assert.doesNotThrow(() => convertNaiToGeneral(null));
    assert.doesNotThrow(() => convertNaiToGeneral('bad'));
    assert.doesNotThrow(() => convertNaiToGeneral({ parameters: 'bad' }));
});

test('图像工具转换', () => {
    const out = convertAugmentToGeneral({
        req_type: 'emotion',
        width: 512,
        height: 512,
        image: 'data:image/png;base64,QUJD',
        defry: 1,
        prompt: 'happy',
    }, { augmentModel: 'nai-diffusion-4-5-full' });
    assert.equal(out.req_type, 'emotion');
    assert.equal(out.image, 'QUJD');
    assert.equal(out.prompt, 'happy');
    assert.equal(out.model, 'nai-diffusion-4-5-full');
});

test('crc32 与已知值一致', () => {
    // "123456789" 的标准 CRC-32 值
    assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('createZip 生成可被标准解压器读取的 ZIP（可往返校验）', async () => {
    const payload = Buffer.from('PNGDATA-'.repeat(100));
    const zip = createZip([{ name: 'image.png', data: payload }]);

    // 结构断言
    assert.equal(zip.readUInt32LE(0), 0x04034b50, '本地文件头签名');
    const nameLen = zip.readUInt16LE(26);
    const extraLen = zip.readUInt16LE(28);
    assert.equal(zip.slice(30, 30 + nameLen).toString(), 'image.png');
    const dataStart = 30 + nameLen + extraLen;
    const size = zip.readUInt32LE(18);
    assert.equal(size, payload.length, '长度字段');
    assert.equal(zip.readUInt32LE(14), crc32(payload), 'CRC 字段');
    assert.deepEqual(zip.slice(dataStart, dataStart + size), payload, '数据体');

    // 中央目录 + EOCD
    const eocd = zip.slice(zip.length - 22);
    assert.equal(eocd.readUInt32LE(0), 0x06054b50, 'EOCD 签名');
    assert.equal(eocd.readUInt16LE(10), 1, '条目数');
    const cdOffset = eocd.readUInt32LE(16);
    assert.equal(zip.readUInt32LE(cdOffset), 0x02014b50, '中央目录签名');
});

test('createZip 支持多条目与中文文件名', () => {
    const zip = createZip([
        { name: 'image.png', data: Buffer.from('A') },
        { name: '第二张.png', data: Buffer.from('B') },
    ]);
    const eocd = zip.slice(zip.length - 22);
    assert.equal(eocd.readUInt16LE(10), 2);
});

test('createZip 输出的 ZIP 能被 inflateRawSync 之外的解压路径验证（store 方式）', () => {
    const data = Buffer.from('hello zip');
    const zip = createZip([{ name: 'a.png', data }]);
    const nameLen = zip.readUInt16LE(26);
    const extraLen = zip.readUInt16LE(28);
    const start = 30 + nameLen + extraLen;
    const method = zip.readUInt16LE(8);
    assert.equal(method, 0, '使用 store 方式');
    assert.equal(zip.slice(start, start + data.length).toString(), 'hello zip');
});

test('parseMultipart 解析 request 字段与文件字段', () => {
    const boundary = '----test123';
    const parts = [
        `--${boundary}`,
        'Content-Disposition: form-data; name="request"',
        '',
        '{"input":"1girl"}',
        `--${boundary}`,
        'Content-Disposition: form-data; name="file"; filename="a.png"',
        'Content-Type: image/png',
        '',
        'BINARY',
        `--${boundary}--`,
        '',
    ];
    const body = Buffer.from(parts.join('\r\n'), 'utf8');
    const { fields, files } = parseMultipart(body, boundary);
    assert.equal(fields.request, '{"input":"1girl"}');
    assert.equal(files.file.filename, 'a.png');
    assert.equal(files.file.data.toString(), 'BINARY');
});

test('parseMultipart 处理缺失 boundary', () => {
    const { fields, files } = parseMultipart(Buffer.from('x'), '');
    assert.deepEqual(fields, {});
    assert.deepEqual(files, {});
});
