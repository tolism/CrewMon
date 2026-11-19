"""Draw the CrewMon logo: a crew of three pixel Bots in front of a radar ring.
Writes media/icon.png (256x256, the Extensions-view and Marketplace icon) and media/icon.svg.
Usage: python3 make_icon.py   (needs Pillow)
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.abspath(__file__))
BG, INK, RING = "#1F2430", "#12151E", "#3A4258"
# The Bot on its 24x24 grid (same as media/critters.js): body cells, visor, eyes
BODY = [(6, 5, 12, 1), (5, 6, 14, 9), (6, 15, 12, 1), (10, 16, 4, 1), (7, 17, 10, 3), (7, 20, 3, 1), (14, 20, 3, 1),
        (3, 9, 2, 3), (19, 9, 2, 3)]
VISOR = [(7, 8, 10, 4)]
EYES = [(9, 9, 2, 2), (13, 9, 2, 2)]
CREW = [  # (centre x, centre y, cell size, body colour, eye colour) — drawn back to front
    (0.205, 0.62, 0.0185, "#4CAF7A", "#9FE3B4"),
    (0.795, 0.62, 0.0185, "#5B8DEF", "#9FE3B4"),
    (0.50, 0.53, 0.0275, "#D97757", "#FFE08A"),
]


def draw(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(0.22 * s), fill=BG)
    for r, w in ((0.40, 0.010), (0.30, 0.008)):                      # radar rings
        c = s / 2
        d.ellipse([c - r * s, 0.52 * s - r * s, c + r * s, 0.52 * s + r * s], outline=RING, width=max(1, int(w * s)))
    for cx, cy, cell, body, eye in CREW:
        u = cell * s
        ox, oy = cx * s - 12 * u, cy * s - 12.5 * u
        def rects(cells, fill):
            for x, y, w, h in cells:
                d.rectangle([ox + x * u, oy + y * u, ox + (x + w) * u - 1, oy + (y + h) * u - 1], fill=fill)
        rects(BODY, body)
        rects(VISOR, INK)
        rects(EYES, eye)
    return img


def svg():
    parts = [f'<rect width="100" height="100" rx="22" fill="{BG}"/>',
             f'<circle cx="50" cy="52" r="40" fill="none" stroke="{RING}" stroke-width="1"/>',
             f'<circle cx="50" cy="52" r="30" fill="none" stroke="{RING}" stroke-width="0.8"/>']
    for cx, cy, cell, body, eye in CREW:
        u = cell * 100
        ox, oy = cx * 100 - 12 * u, cy * 100 - 12.5 * u
        for cells, fill in ((BODY, body), (VISOR, INK), (EYES, eye)):
            for x, y, w, h in cells:
                parts.append(f'<rect x="{ox + x*u:.2f}" y="{oy + y*u:.2f}" width="{w*u:.2f}" height="{h*u:.2f}" fill="{fill}"/>')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" shape-rendering="crispEdges">' + "".join(parts) + "</svg>\n"


os.makedirs(os.path.join(ROOT, "media"), exist_ok=True)
draw(1024).resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "media", "icon.png"))
with open(os.path.join(ROOT, "media", "icon.svg"), "w") as f:
    f.write(svg())
print("media/icon.png, media/icon.svg")
