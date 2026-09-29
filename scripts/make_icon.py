"""生成 unraid 容器图标（512x512 PNG），供 Docker 模板使用。

设计：圆角方形渐变底 + 白色云 + 上传箭头，表达「NAI 请求 -> 云端转换」。
"""

from PIL import Image, ImageDraw

SIZE = 512
SS = 4  # 超采样倍数，用于抗锯齿
W = SIZE * SS

img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


# ---- 渐变背景（对角线性渐变） ----
stops = [
    (0.00, (30, 58, 138)),    # #1e3a8a
    (0.55, (37, 99, 235)),    # #2563eb
    (1.00, (34, 211, 238)),   # #22d3ee
]

bg = Image.new("RGB", (W, W))
bg_px = bg.load()
for y in range(W):
    for x in range(W):
        t = (x + y) / (2 * (W - 1))
        # 找到所在渐变区间
        for i in range(len(stops) - 1):
            t0, c0 = stops[i]
            t1, c1 = stops[i + 1]
            if t0 <= t <= t1:
                local = (t - t0) / (t1 - t0) if t1 > t0 else 0
                bg_px[x, y] = lerp(c0, c1, local)
                break
        else:
            bg_px[x, y] = stops[-1][1]

# 圆角遮罩
mask = Image.new("L", (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=int(W * 0.22), fill=255)
img.paste(bg, (0, 0), mask)

draw = ImageDraw.Draw(img)


def s(v):
    """把设计坐标（基于 512）换算到超采样画布。"""
    return int(v * SS)


# ---- 白色云朵 ----
cloud_color = (255, 255, 255, 255)

# 云的主体
draw.ellipse([s(110), s(150), s(245), s(285)], fill=cloud_color)   # 左圆
draw.ellipse([s(190), s(105), s(355), s(270)], fill=cloud_color)   # 上圆
draw.ellipse([s(300), s(150), s(425), s(275)], fill=cloud_color)   # 右圆
draw.rounded_rectangle([s(110), s(215), s(425), s(285)], radius=s(35), fill=cloud_color)

# ---- 向下箭头（表示请求送入云端转换）----
arrow_color = (30, 58, 138, 255)
# 箭杆
draw.rounded_rectangle([s(243), s(320), s(277), s(400)], radius=s(17), fill=arrow_color)
# 箭头三角
draw.polygon([(s(212), s(388)), (s(308), s(388)), (s(260), s(452))], fill=arrow_color)

# ---- 装饰点 ----
draw.ellipse([s(370), s(70), s(420), s(120)], fill=(250, 204, 21, 255))    # 黄色
draw.ellipse([s(85), s(85), s(120), s(120)], fill=(244, 114, 182, 255))    # 粉色

# ---- 降采样到目标尺寸 ----
final = img.resize((SIZE, SIZE), Image.LANCZOS)
final.save("icon.png", "PNG", optimize=True)
print(f"已生成 icon.png  {final.size[0]}x{final.size[1]}")
