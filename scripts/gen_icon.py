"""生成应用图标（纯标准库，无 PIL 依赖）。"""
import zlib, struct, os, math

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')
os.makedirs(OUT, exist_ok=True)


def rounded_rect(x, y, w, h, r):
    """返回判断点是否在圆角矩形内的函数"""
    def inside(px, py):
        cx = min(max(px, r), w - r)
        cy = min(max(py, r), h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return inside


def lerp(a, b, t):
    return a + (b - a) * t


def render(size, mono_white=False):
    """渲染图标为 RGBA 像素矩阵"""
    S = 4  # 超采样
    n = size * S
    acc = [[(0, 0, 0, 0)] * n for _ in range(n)]
    r = n * 0.24
    inside = rounded_rect(0, 0, n, n, r)
    for y in range(n):
        t = y / (n - 1)
        if mono_white:
            top = (255, 255, 255)
            bot = (255, 255, 255)
        else:
            top = (255, 138, 96)
            bot = (223, 60, 42)
        base = tuple(int(lerp(top[i], bot[i], t ** 0.9)) for i in range(3))
        for x in range(n):
            if inside(x + 0.5, y + 0.5):
                acc[y][x] = (*base, 255)

    # 中央白色摊开书本：左右两页（倾斜四边形）
    def draw_quad(pts, color, alpha=255):
        # 扫描线填充
        minx = int(min(p[0] for p in pts)); maxx = int(max(p[0] for p in pts))
        miny = int(min(p[1] for p in pts)); maxy = int(max(p[1] for p in pts))
        for py in range(max(0, miny), min(n, maxy + 1)):
            xs = []
            for i in range(len(pts)):
                x1, y1 = pts[i]; x2, y2 = pts[(i + 1) % len(pts)]
                if (y1 <= py < y2) or (y2 <= py < y1):
                    xs.append(x1 + (py - y1) * (x2 - x1) / (y2 - y1))
            if len(xs) < 2:
                continue
            xs.sort()
            for px in range(max(0, int(xs[0])), min(n, int(xs[-1]) + 1)):
                ox, oy, ob, oa = acc[py][px]
                acc[py][px] = (
                    int(lerp(ox, color[0], alpha / 255)),
                    int(lerp(oy, color[1], alpha / 255)),
                    int(lerp(ob, color[2], alpha / 255)),
                    max(oa, alpha),
                )

    cx, cy = n / 2, n / 2
    bw = n * 0.20          # 单页宽
    bh = n * 0.26          # 页高
    gap = n * 0.035
    lift = n * 0.045
    # 左页
    draw_quad([
        (cx - gap - bw, cy - bh * 0.72 + lift), (cx - gap * 0.35, cy - bh * 0.95 + lift * 0.35),
        (cx - gap * 0.35, cy + bh * 0.55), (cx - gap - bw, cy + bh * 0.78),
    ], (255, 255, 255))
    # 右页
    draw_quad([
        (cx + gap * 0.35, cy - bh * 0.95 + lift * 0.35), (cx + gap + bw, cy - bh * 0.72 + lift),
        (cx + gap + bw, cy + bh * 0.78), (cx + gap * 0.35, cy + bh * 0.55),
    ], (255, 255, 255))

    # 降采样
    out = bytearray()
    for y in range(size):
        out.append(0)
        for x in range(size):
            rs = gs = bs = as_ = 0
            for dy in range(S):
                for dx in range(S):
                    p = acc[y * S + dy][x * S + dx]
                    a = p[3]
                    rs += p[0] * a; gs += p[1] * a; bs += p[2] * a; as_ += a
            if as_ == 0:
                out += bytes([0, 0, 0, 0])
            else:
                out += bytes([min(255, rs // as_), min(255, gs // as_), min(255, bs // as_), min(255, as_ // (S * S))])
    return bytes(out)


def write_png(path, size, data):
    raw = data
    comp = zlib.compress(raw, 9)

    def chunk(typ, body):
        c = struct.pack('>I', len(body)) + typ + body
        return c + struct.pack('>I', zlib.crc32(typ + body) & 0xFFFFFFFF)

    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', comp)
    png += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


for s, name in [(256, 'icon.png'), (64, 'tray.png'), (32, 'tray@1x.png')]:
    write_png(os.path.join(OUT, name), s, render(s))
print('icons ->', OUT, os.listdir(OUT))
