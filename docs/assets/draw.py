# Generates the YShare README diagrams in a hand-drawn "explained on a black
# board" style: dark canvas, white ink, sparse accent colour, wobbly strokes.
# Deterministic: the same seed always produces the same drawing.
import io, math, base64

FONT_B64 = io.open('font-b64.txt').read().strip()

BG      = '#0a0a0a'
INK     = '#ededed'
DIM     = '#8b8b8b'
PINK    = '#ff7ab6'
GREEN   = '#7ee787'
YELLOW  = '#ffd866'
BLUE    = '#79c0ff'
ORANGE  = '#ff8a4c'

class Pen:
    def __init__(self, seed=7):
        self.s = seed
        self.out = []
    def r(self):
        self.s = (self.s * 1103515245 + 12345) % 2147483648
        return self.s / 2147483648.0
    def j(self, amt):
        return (self.r() - 0.5) * 2 * amt

    def line(self, x1, y1, x2, y2, color=INK, w=2.2, wob=1.6, passes=2):
        for p in range(passes):
            a = 0.7 if p else 1.0
            mx = (x1 + x2) / 2 + self.j(wob * 2)
            my = (y1 + y2) / 2 + self.j(wob * 2)
            self.out.append(
                f'<path d="M {x1+self.j(wob):.1f} {y1+self.j(wob):.1f} '
                f'Q {mx:.1f} {my:.1f} {x2+self.j(wob):.1f} {y2+self.j(wob):.1f}" '
                f'fill="none" stroke="{color}" stroke-width="{w:.1f}" '
                f'stroke-linecap="round" opacity="{a}"/>')

    def rect(self, x, y, w, h, color=INK, sw=2.2, wob=1.7):
        self.line(x, y, x + w, y, color, sw, wob)
        self.line(x + w, y, x + w, y + h, color, sw, wob)
        self.line(x + w, y + h, x, y + h, color, sw, wob)
        self.line(x, y + h, x, y, color, sw, wob)

    def dashed(self, x1, y1, x2, y2, color=DIM, w=1.8, dash=9, gap=7):
        d = math.hypot(x2 - x1, y2 - y1)
        if d == 0: return
        ux, uy = (x2 - x1) / d, (y2 - y1) / d
        t = 0.0
        while t < d:
            e = min(t + dash, d)
            self.line(x1 + ux * t, y1 + uy * t, x1 + ux * e, y1 + uy * e,
                      color, w, 0.6, passes=1)
            t = e + gap

    def head(self, x, y, ang, color=INK, size=13, w=2.4):
        for k in (2.5, -2.5):
            hx = x - size * math.cos(ang + k * 0.16 * math.pi)
            hy = y - size * math.sin(ang + k * 0.16 * math.pi)
            self.line(x, y, hx, hy, color, w, 0.7, passes=1)

    def arrow(self, x1, y1, x2, y2, color=INK, w=2.3, bow=0.0, wob=1.2):
        mx = (x1 + x2) / 2 + bow * (y2 - y1) * 0.28 + self.j(wob)
        my = (y1 + y2) / 2 - bow * (x2 - x1) * 0.28 + self.j(wob)
        self.out.append(
            f'<path d="M {x1:.1f} {y1:.1f} Q {mx:.1f} {my:.1f} {x2:.1f} {y2:.1f}" '
            f'fill="none" stroke="{color}" stroke-width="{w:.1f}" stroke-linecap="round"/>')
        self.head(x2, y2, math.atan2(y2 - my, x2 - mx), color, 13, w)

    def text(self, x, y, s, size=20, color=INK, anchor='start', rot=0, op=1.0):
        t = f' transform="rotate({rot} {x} {y})"' if rot else ''
        s = (s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;'))
        self.out.append(
            f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" '
            f'text-anchor="{anchor}" opacity="{op}" class="hand"{t}>{s}</text>')

    def title(self, x, y, s, size=34, color=INK, anchor='start', ul=True):
        self.text(x, y, s, size, color, anchor)
        if ul:
            w = len(s) * size * 0.47
            x0 = x if anchor == 'start' else x - w / 2
            self.line(x0, y + 11, x0 + w, y + 11, color, 2.2, 1.4)

    def svg(self, w, h, label):
        style = (
            '<style>'
            '@font-face{font-family:"Hand";'
            f'src:url(data:font/woff2;base64,{FONT_B64}) format("woff2");'
            'font-display:swap}'
            '.hand{font-family:"Hand","Architects Daughter","Ink Free","Segoe Print",'
            '"Bradley Hand","Chalkboard SE",cursive}'
            '</style>')
        body = '\n  '.join(self.out)
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" '
                f'width="{w}" height="{h}" role="img" aria-label="{label}">\n'
                f'  {style}\n'
                f'  <rect width="{w}" height="{h}" fill="{BG}"/>\n'
                f'  {body}\n</svg>\n')


def write(name, svg):
    io.open(f'out/{name}.svg', 'w', encoding='utf-8', newline='\n').write(svg)
    print(f'{name}.svg  {len(svg)/1024:.0f} KB')


import os
os.makedirs('out', exist_ok=True)

# ---------------------------------------------------------------- 1. THE PITCH
p = Pen(11)
p.text(60, 74, 'YShare', 62, INK)
p.line(60, 92, 250, 92, ORANGE, 3.0, 2.0)
p.text(62, 128, 'send a file straight to someone', 24, DIM)

# two devices with a fat arrow between
p.rect(70, 190, 200, 110)
p.text(170, 232, 'your', 26, INK, 'middle')
p.text(170, 264, 'device', 26, INK, 'middle')

p.rect(730, 190, 200, 110)
p.text(830, 232, 'their', 26, INK, 'middle')
p.text(830, 264, 'device', 26, INK, 'middle')

p.arrow(285, 236, 715, 236, ORANGE, 3.4)
p.arrow(715, 262, 285, 262, ORANGE, 2.0)
p.text(500, 214, 'the file itself', 24, ORANGE, 'middle')
p.text(500, 300, 'encrypted, direct, no copy kept', 19, DIM, 'middle')

p.text(500, 366, 'no account   ·   no upload   ·   no cloud', 22, INK, 'middle')
write('01-pitch', p.svg(1000, 410, 'YShare sends a file straight between two devices, encrypted and direct, with no account, no upload and no cloud copy.'))

# ------------------------------------------------------------- 2. HOW IT WORKS
p = Pen(23)
p.title(60, 62, 'how it works', 34, INK)

# step 1
p.text(70, 130, '1', 30, YELLOW)
p.text(100, 130, 'you pick a file', 26, INK)
p.rect(100, 152, 120, 84)
p.line(120, 178, 200, 178, DIM, 1.8, 1.2, passes=1)
p.line(120, 196, 200, 196, DIM, 1.8, 1.2, passes=1)
p.line(120, 214, 172, 214, DIM, 1.8, 1.2, passes=1)
p.text(100, 264, 'or a whole folder', 18, DIM)

p.arrow(238, 194, 318, 194, DIM, 2.0)

# step 2
p.text(340, 130, '2', 30, YELLOW)
p.text(368, 130, 'you get a code', 26, INK)
for i, ch in enumerate('K4PZ7M'):
    x = 360 + i * 44
    p.rect(x, 152, 36, 50, INK, 2.0)
    p.text(x + 18, 187, ch, 26, PINK, 'middle')
p.text(368, 264, 'read it out, text it, whatever', 18, DIM)

p.arrow(650, 194, 726, 194, DIM, 2.0)

# step 3
p.text(748, 130, '3', 30, YELLOW)
p.text(776, 130, 'they accept', 26, INK)
p.rect(748, 152, 176, 84)
p.text(836, 184, 'incoming:', 18, DIM, 'middle')
p.text(836, 212, 'holiday.zip', 20, INK, 'middle')
p.arrow(836, 246, 836, 276, GREEN, 2.4)
p.text(836, 300, 'accept', 24, GREEN, 'middle')
p.text(748, 336, 'nothing lands without a tap', 17, DIM)

# the payoff line
p.dashed(60, 372, 940, 372)
p.text(500, 408, 'then it transfers, checks itself, and tells you the truth', 22, INK, 'middle')
write('02-how-it-works', p.svg(1000, 440, 'Three steps: you pick a file, you get a six character code, they see what it is and accept. Then it transfers, checks itself and reports honestly.'))

# ------------------------------------------------------- 3. WHAT GOES WHERE
p = Pen(31)
p.title(60, 62, 'what actually goes where', 34, INK)

p.rect(70, 130, 190, 96)
p.text(165, 168, 'you', 26, INK, 'middle')
p.text(165, 200, 'the file', 20, DIM, 'middle')

p.rect(740, 130, 190, 96)
p.text(835, 168, 'them', 26, INK, 'middle')
p.text(835, 200, 'the file', 20, DIM, 'middle')

# the fat direct route
p.arrow(275, 178, 725, 178, ORANGE, 4.0)
p.text(500, 152, 'every byte, direct', 24, ORANGE, 'middle')

# the thin introduction route
p.dashed(165, 240, 165, 300, DIM)
p.dashed(835, 240, 835, 300, DIM)
p.dashed(165, 300, 420, 300, DIM)
p.dashed(835, 300, 580, 300, DIM)
p.rect(420, 272, 160, 58, DIM, 1.8)
p.text(500, 296, 'a few KB', 20, DIM, 'middle')
p.text(500, 320, 'to introduce them', 16, DIM, 'middle')

p.arrow(640, 300, 700, 348, PINK, 2.2, bow=0.3)
p.text(706, 362, 'never sees your file', 19, PINK)

p.line(60, 398, 940, 398, DIM, 1.6, 1.2, passes=1)
p.text(60, 436, 'we run none of these servers.', 26, INK)
p.text(60, 468, 'you point it at one you trust, or skip it and paste a code by hand.', 20, DIM)
write('03-what-goes-where', p.svg(1000, 500, 'The file goes directly between the two people. Only a few kilobytes of introduction touch a server, which never sees the file. YShare runs none of these servers.'))

# ------------------------------------------------------------ 4. WHY IT IS QUICK
p = Pen(43)
p.title(60, 62, 'why it is quick', 34, INK)

p.rect(70, 120, 130, 190)
p.text(135, 108, 'one file', 20, DIM, 'middle')
for i in range(8):
    y = 132 + i * 22
    p.line(84, y, 186, y, ORANGE, 2.0, 1.0, passes=1)

p.text(500, 108, 'cut into 8 pieces, all moving at once', 22, INK, 'middle')
for i in range(8):
    y = 132 + i * 22
    p.line(215, y, 760, y, ORANGE, 1.8, 1.4, passes=1)
    p.head(768, y, 0, ORANGE, 10, 2.0)

p.rect(800, 120, 130, 190)
p.text(865, 108, 'put back', 20, DIM, 'middle')
p.line(830, 250, 855, 275, GREEN, 4.0, 1.0)
p.line(855, 275, 905, 205, GREEN, 4.0, 1.0)

p.arrow(865, 330, 865, 372, GREEN, 2.4)
p.text(865, 398, 'checked with SHA-256', 20, GREEN, 'middle')
p.text(500, 398, 'before you are told it worked', 20, DIM, 'middle')
write('04-why-quick', p.svg(1000, 430, 'The file is cut into eight pieces that all move at the same time, then put back in order and checked with a SHA-256 hash before success is reported.'))
