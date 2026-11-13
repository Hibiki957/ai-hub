#!/usr/bin/env python3
"""生成 Adobe Illustrator 风格 AI Hub 图标: 深棕圆角方块 + 橙色 Ai 字母"""
from PIL import Image, ImageDraw, ImageFont

SIZE = 1024
BG = "#F0EEE6"        # Claude 奶油底
FG = "#D97757"        # Claude 橙
RADIUS = 230          # 圆角（≈macOS squircle 近似）

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
mask = Image.new("L", (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, SIZE, SIZE], radius=RADIUS, fill=255)

bg = Image.new("RGBA", (SIZE, SIZE), BG)
img.paste(bg, (0, 0), mask)

d = ImageDraw.Draw(img)
# 字体：Helvetica Bold（Illustrator 字母是等线粗体感觉）
font = None
for path, idx in [("/System/Library/Fonts/SFNSRounded.ttf", 1),
                  ("/System/Library/Fonts/Helvetica.ttc", 1)]:
    try:
        font = ImageFont.truetype(path, int(SIZE * 0.62), index=idx)
        break
    except Exception:
        continue
if font is None:
    font = ImageFont.load_default()

text = "Ai"
bbox = d.textbbox((0, 0), text, font=font)
tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
x = (SIZE - tw) / 2 - bbox[0]
y = (SIZE - th) / 2 - bbox[1] - SIZE * 0.02   # 上移补偿 descender，光学居中
d.text((x, y), text, font=font, fill=FG)

img.save("icon_1024.png")

# 生成 iconset 全套尺寸
import os
os.makedirs("AppIcon.iconset", exist_ok=True)
for name, px in [("icon_16x16",16),("icon_16x16@2x",32),("icon_32x32",32),
                 ("icon_32x32@2x",64),("icon_128x128",128),("icon_128x128@2x",256),
                 ("icon_256x256",256),("icon_256x256@2x",512),("icon_512x512",512),
                 ("icon_512x512@2x",1024)]:
    img.resize((px, px), Image.LANCZOS).save(f"AppIcon.iconset/{name}.png")
print("icon_1024.png + AppIcon.iconset 生成完毕")
