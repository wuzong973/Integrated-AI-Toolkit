#!/usr/bin/env python3
"""TabBar 图标生成器（纯标准库，无第三方依赖）

用途：按 docs/dev/MP-VISUAL-SYSTEM.md 的糖果图标规范，生成 apps/mp/assets/icons/
     下的 5 组 TabBar 图标（每组 normal + active 两张 81×81 PNG）。

为什么不直接用 Pillow：仓库合规要求（红线：引入任何新依赖前先登记），
本脚本用标准库自绘 + 自写 PNG 编码，零依赖、可复现。

用法：
    python scripts/dev/gen-tab-icons.py            # 生成图标
    python scripts/dev/gen-tab-icons.py --preview  # 额外输出预览图便于肉眼校验
"""

from __future__ import annotations

import argparse
import math
import struct
import zlib
from pathlib import Path

# ---------- 输出位置 ----------
ROOT = Path(__file__).resolve().parents[2]
ICON_DIR = ROOT / 'apps' / 'mp' / 'assets' / 'icons'

# ---------- 画布参数 ----------
SIZE = 81          # 小程序 TabBar 推荐尺寸
SS = 4             # 超采样倍率（先画大图再缩小，得到平滑边缘）
BG = (255, 255, 255)   # 预览图背景
MUTED = (176, 186, 205)  # 未选中态的混色目标：统一的中性蓝灰
MUTED_MIX = 0.42         # 未选中态混色比例（越大越灰；0.42 仍能看出各自的色相）


# ==================== 极简光栅化器 ====================
class Canvas:
    """RGBA 画布：形状先算覆盖率，再按 source-over 合成。"""

    def __init__(self, size: int) -> None:
        self.size = size
        self.px = [[0.0, 0.0, 0.0, 0.0] for _ in range(size * size)]

    def _blend(self, x: int, y: int, color: tuple[int, int, int], alpha: float) -> None:
        if alpha <= 0:
            return
        dst = self.px[y * self.size + x]
        da = dst[3]
        out_a = alpha + da * (1 - alpha)
        if out_a <= 0:
            dst[0] = dst[1] = dst[2] = dst[3] = 0.0
            return
        for i in range(3):
            src = color[i] / 255.0
            dst[i] = (src * alpha + dst[i] * da * (1 - alpha)) / out_a
        dst[3] = out_a

    def fill(self, shape, color, cut: bool = False) -> None:
        """shape = (test, bbox)；test(x, y) -> bool 给出覆盖率，cut=True 表示挖空。"""
        test, bbox = shape
        n = self.size
        x0, y0, x1, y1 = bbox
        x0 = max(0, int(x0)); y0 = max(0, int(y0))
        x1 = min(n, int(math.ceil(x1))); y1 = min(n, int(math.ceil(y1)))
        for py in range(y0, y1):
            for px in range(x0, x1):
                hits = 0
                for sy in range(SS):
                    yy = py * SS + sy + 0.5
                    for sx in range(SS):
                        if test(px * SS + sx + 0.5, yy):
                            hits += 1
                if not hits:
                    continue
                cov = hits / (SS * SS)
                if cut:
                    self.px[py * n + px][3] *= 1 - cov
                else:
                    self._blend(px, py, color, cov)

    def to_rgba(self) -> bytes:
        n = self.size
        out = bytearray(n * n * 4)
        for i, (r, g, b, a) in enumerate(self.px):
            out[i * 4] = int(round(max(0.0, min(1.0, r)) * 255))
            out[i * 4 + 1] = int(round(max(0.0, min(1.0, g)) * 255))
            out[i * 4 + 2] = int(round(max(0.0, min(1.0, b)) * 255))
            out[i * 4 + 3] = int(round(max(0.0, min(1.0, a)) * 255))
        return bytes(out)


# ---------- 形状测试函数（坐标均为超采样空间） ----------
def circle(cx, cy, r):
    rr = r * r
    test = lambda x, y: (x - cx * SS) ** 2 + (y - cy * SS) ** 2 <= rr * SS * SS
    return test, (cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1)


def rrect(x0, y0, x1, y1, r):
    def test(x, y):
        px, py = x / SS, y / SS
        if px < x0 or px > x1 or py < y0 or py > y1:
            return False
        cx = min(max(px, x0 + r), x1 - r)
        cy = min(max(py, y0 + r), y1 - r)
        if px == cx and py == cy:
            return True
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return test, (x0 - 1, y0 - 1, x1 + 1, y1 + 1)


def seg(p0, p1, w):
    """带圆头的粗线段。"""
    (ax, ay), (bx, by) = p0, p1
    half = w / 2.0

    def test(x, y):
        px, py = x / SS, y / SS
        dx, dy = bx - ax, by - ay
        length2 = dx * dx + dy * dy
        t = 0.0 if length2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length2))
        nx, ny = ax + t * dx, ay + t * dy
        return (px - nx) ** 2 + (py - ny) ** 2 <= half * half
    xs = [ax, bx]; ys = [ay, by]
    return test, (min(xs) - w, min(ys) - w, max(xs) + w, max(ys) + w)


def arc(cx, cy, r, w, a0, a1):
    """圆环上的弧段（角度制，0° 指向右，顺时针增大）。"""
    half = w / 2.0

    def test(x, y):
        px, py = x / SS - cx, y / SS - cy
        d = math.hypot(px, py)
        if abs(d - r) > half:
            return False
        ang = math.degrees(math.atan2(py, px)) % 360
        return a0 <= ang <= a1
    return test, (cx - r - w, cy - r - w, cx + r + w, cy + r + w)


def poly(points):
    def test(x, y):
        px, py = x / SS, y / SS
        inside = False
        n = len(points)
        for i in range(n):
            x1, y1 = points[i]
            x2, y2 = points[(i + 1) % n]
            if (y1 > py) != (y2 > py):
                xin = x1 + (py - y1) / (y2 - y1) * (x2 - x1)
                if px < xin:
                    inside = not inside
        return inside
    xs = [p[0] for p in points]; ys = [p[1] for p in points]
    return test, (min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1)


def sparkle(cx, cy, r, waist=0.36):
    """四角星（糖果感的"闪光"造型）。"""
    w = r * waist
    pts = [(cx, cy - r), (cx + w, cy - w), (cx + r, cy),
           (cx + w, cy + w), (cx, cy + r), (cx - w, cy + w),
           (cx - r, cy), (cx - w, cy - w)]
    return poly(pts)


# ---------- 颜色工具 ----------
def mix(color, target, ratio):
    return tuple(int(round(color[i] * (1 - ratio) + target[i] * ratio)) for i in range(3))


# ==================== 图标定义 ====================
# 每个图标 = (主色, 辅色, 点缀色, 绘制函数)
def draw_home(c: Canvas, main, accent, third) -> None:
    c.fill(rrect(50, 11, 57, 26, 2.4), accent)
    c.fill(seg((16, 37), (40.5, 16.5), 8.6), main)
    c.fill(seg((40.5, 16.5), (65, 37), 8.6), main)
    c.fill(circle(40.5, 16.5, 4.3), main)
    c.fill(rrect(20, 33, 61, 68, 10), main)
    c.fill(circle(27.5, 44, 3.4), accent)
    c.fill(rrect(33, 52, 48, 68, 5), None, cut=True)


def draw_toolbox(c: Canvas, main, accent, third) -> None:
    c.fill(arc(40.5, 27.5, 12.5, 6, 180, 360), accent)
    c.fill(rrect(11, 27, 70, 66, 11), main)
    c.fill(rrect(11, 39.5, 70, 45.5, 2.2), accent)
    c.fill(rrect(35.5, 36, 45.5, 51, 3.4), accent)


def draw_ai(c: Canvas, main, accent, third) -> None:
    c.fill(sparkle(40.5, 40.5, 27.5), main)
    c.fill(sparkle(62.5, 20, 7.2), third)
    c.fill(circle(19, 60.5, 4.2), accent)


def draw_station(c: Canvas, main, accent, third) -> None:
    c.fill(seg((57, 20), (57, 9), 2.8), third)
    c.fill(poly([(57, 8.6), (67, 12), (57, 15.4)]), accent)
    for i in range(5):
        c.fill(circle(15.4 + i * 12.6, 34.5, 6.2), main)
    c.fill(rrect(10, 19, 71, 35, 6), main)
    c.fill(rrect(17, 33, 64, 68, 6), main)
    c.fill(circle(25.5, 44.5, 3.8), accent)
    c.fill(rrect(33, 51, 48, 68, 4), None, cut=True)


def draw_mine(c: Canvas, main, accent, third) -> None:
    c.fill(arc(40.5, 30, 15.6, 7.2, 175, 365), accent)
    c.fill(circle(40.5, 30, 13.6), main)
    c.fill(rrect(13, 50, 68, 74, 14), main)
    c.fill(circle(56, 18.5, 3.6), third)


ICONS = [
    ('home', (0, 184, 169), (78, 216, 196), (255, 176, 32), draw_home),
    ('toolbox', (59, 110, 246), (125, 166, 255), (255, 122, 69), draw_toolbox),
    ('ai', (124, 107, 248), (167, 139, 250), (251, 191, 36), draw_ai),
    ('station', (255, 138, 61), (255, 192, 107), (255, 110, 40), draw_station),
    ('mine', (236, 72, 153), (249, 168, 212), (251, 191, 36), draw_mine),
]


# ==================== PNG 编码（标准库） ====================
def write_png(path: Path, width: int, height: int, rgba: bytes) -> None:
    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter: none
        raw += rgba[y * stride:(y + 1) * stride]

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    path.write_bytes(png)


def render(draw, colors, muted: bool) -> bytes:
    c = Canvas(SIZE)
    if muted:
        colors = tuple(mix(col, MUTED, MUTED_MIX) for col in colors)
    draw(c, *colors)
    return c.to_rgba()


def make_preview(images, path: Path) -> None:
    """把 10 张图标排成 2×5 预览图，方便肉眼校验造型与配色。"""
    cell, pad = SIZE, 12
    w = pad + 5 * (cell + pad)
    h = pad + 2 * (cell + pad)
    buf = bytearray()
    for y in range(h):
        for x in range(w):
            buf += bytes(BG) + b'\xff'
    for row, key in enumerate(('normal', 'active')):
        for col, item in enumerate(ICONS):
            name = item[0]
            data = images[(name, key)]
            ox = pad + col * (cell + pad)
            oy = pad + row * (cell + pad)
            for y in range(cell):
                for x in range(cell):
                    i = (y * cell + x) * 4
                    a = data[i + 3] / 255.0
                    if a <= 0:
                        continue
                    j = ((oy + y) * w + ox + x) * 4
                    for k in range(3):
                        buf[j + k] = int(round(data[i + k] * a + BG[k] * (1 - a)))
    write_png(path, w, h, bytes(buf))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--preview', action='store_true', help='同时输出预览图')
    args = parser.parse_args()

    ICON_DIR.mkdir(parents=True, exist_ok=True)
    images = {}
    for name, main_c, accent, third, draw in ICONS:
        for key, muted in (('', True), ('-active', False)):
            rgba = render(draw, (main_c, accent, third), muted)
            images[(name, 'normal' if muted else 'active')] = rgba
            out = ICON_DIR / f'{name}{key}.png'
            write_png(out, SIZE, SIZE, rgba)
            print(f'[ok] {out.relative_to(ROOT)}')

    if args.preview:
        target = ROOT / 'logs' / 'tabbar-icons-preview.png'
        target.parent.mkdir(parents=True, exist_ok=True)
        make_preview(images, target)
        print(f'[ok] {target.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
