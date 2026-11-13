"""Generate bundled PWA icons with Pillow; no remote assets or fonts required."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'public'
scale = 4
image = Image.new('RGB', (512 * scale, 512 * scale), '#176b52')
d = ImageDraw.Draw(image)
def bezier(a, b, c, e):
    return [tuple(int(scale * ((1-t)**3*a[k] + 3*(1-t)**2*t*b[k] + 3*(1-t)*t*t*c[k] + t**3*e[k])) for k in range(2)) for t in [n/60 for n in range(61)]]
leaf = bezier((149,333),(146,215),(224,148),(368,144)) + bezier((368,144),(369,288),(299,365),(184,368))
d.polygon(leaf, fill='#e5f1bd')
for start, end in [((147,374),(291,230)),((222,299),(222,238)),((222,299),(285,299))]:
    d.line([tuple(scale*n for n in start), tuple(scale*n for n in end)], fill='#176b52', width=19*scale)
    for p in [start,end]:
        x,y=p
        d.ellipse(((x-9)*scale,(y-9)*scale,(x+9)*scale,(y+9)*scale),fill='#176b52')
for size in (192,512):
    image.resize((size,size),Image.Resampling.LANCZOS).save(root / f'icon-{size}.png')
print('Generated 192px and 512px PWA icons.')
