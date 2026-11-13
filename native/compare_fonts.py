#!/usr/bin/env python3
"""生成 4 种字体的 Ai 图标候选 + 对比图"""
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
BG = "#F0EEE6"; FG = "#D97757"; RADIUS = 230

FONTS = [
    ("SF Rounded",  "/System/Library/Fonts/SFNSRounded.ttf", 1),   # 圆润现代
    ("New York",    "/System/Library/Fonts/NewYork.ttf", 3),       # 衬线优雅（Claude 品牌感）
    ("Futura",      "/System/Library/Fonts/Supplemental/Futura.ttc", 2),  # 几何无衬线
    ("SF Mono",     "/System/Library/Fonts/SFNSMono.ttf", 1),      # 等宽极客
]

def make_icon(font_path, index, scale=0.62, yoff=0.02):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mask = Image.new("L", (SIZE, SIZE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, SIZE, SIZE], radius=RADIUS, fill=255)
    img.paste(Image.new("RGBA", (SIZE, SIZE), BG), (0, 0), mask)
    d = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(font_path, int(SIZE * scale), index=index)
    except Exception:
        font = ImageFont.truetype(font_path, int(SIZE * scale))
    text = "Ai"
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text(((SIZE - tw) / 2 - bbox[0], (SIZE - th) / 2 - bbox[1] + SIZE * yoff), text, font=font, fill=FG)
    return img

# 单图（256px 展示）
thumbs = []
for i, (name, path, idx) in enumerate(FONTS):
    icon = make_icon(path, idx)
    icon.resize((256, 256), Image.LANCZOS).save(f"icon_var_{i}.png")
    thumbs.append((name, icon.resize((256, 256), Image.LANCZOS)))

# 对比图：2x2，奶油底
W, H = 256 * 2 + 60, 256 * 2 + 100
sheet = Image.new("RGBA", (W, H), "#F5F4EF")
sd = ImageDraw.Draw(sheet)
try:
    lf = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 22)
except Exception:
    lf = ImageFont.load_default()
positions = [(20, 20), (20 + 256 + 20, 20), (20, 20 + 256 + 40), (20 + 256 + 20, 20 + 256 + 40)]
for i, (name, thumb) in enumerate(thumbs):
    x, y = positions[i]
    sheet.paste(thumb, (x, y), thumb)
    sd.text((x + 70, y + 260), f"{i+1}. {name}", font=lf, fill="#141413")
sheet.convert("RGB").save("ai-hub-icon-compare.png")
print("对比图已生成: ai-hub-icon-compare.png")
