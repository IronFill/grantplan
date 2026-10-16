"""Original GrantPlan typographic educational cards; Pillow, no stock imagery.
Run with --font-dir to use another licensed/system font directory.
"""
from pathlib import Path
import argparse
from PIL import Image, ImageDraw, ImageFont

parser = argparse.ArgumentParser()
parser.add_argument('--font-dir', default='C:/Windows/Fonts')
args = parser.parse_args()
OUT = Path(__file__).parent
FONTS = Path(args.font_dir)
INK = '#16282A'
CREAM = '#F6F2E9'
ORANGE = '#F4A442'
MUTED = '#516365'

def font(size, bold=False):
    return ImageFont.truetype(str(FONTS / ('arialbd.ttf' if bold else 'arial.ttf')), size)

def text(d, xy, value, size=42, fill=INK, bold=False):
    # Explicit line breaks are intentional; fail instead of silently clipping.
    for i, line in enumerate(value.split('\n')):
        y = xy[1] + i * int(size * 1.22)
        box = d.textbbox((xy[0], y), line, font=font(size, bold))
        assert box[2] <= 1016 and box[3] <= 1300, (value, box)
        d.text((xy[0], y), line, font=font(size, bold), fill=fill)

def base(n, topic):
    im = Image.new('RGB', (1080, 1350), CREAM)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((64, 64, 122, 122), radius=16, fill=ORANGE)
    text(d, (79, 74), 'G', 35, bold=True)
    text(d, (142, 74), 'ГрантПлан', 34, bold=True)
    text(d, (64, 170), topic.upper(), 27, MUTED, True)
    d.line((64, 1200, 1016, 1200), fill='#D7DCD5', width=2)
    text(d, (64, 1230), 'grantplan.com.ua', 35, bold=True)
    text(d, (935, 1235), f'{n}/3', 28, MUTED)
    return im, d

im, d = base(1, 'Кошторис без сюрпризів')
text(d, (64, 245), '100 000', 152, bold=True)
text(d, (73, 425), 'грн у таблиці', 49, MUTED)
d.rounded_rectangle((64, 555, 1016, 780), radius=32, fill=INK)
text(d, (104, 598), 'А доставка —\nпішки?', 69, CREAM, True)
text(d, (64, 862), 'Правильний підсумок —\nще не повна перевірка.', 49, bold=True)
text(d, (64, 1040), 'Гортайте: 3 питання до кошторису →', 36, MUTED)
im.save(OUT / '01-hook.png')

im, d = base(2, 'Перед тим як переносити ціну')
text(d, (64, 240), 'Перевірте\nтри речі', 86, bold=True)
items = [('01', 'Комплектація', 'Той самий артикул, кількість\nі все потрібне для роботи.'),
         ('02', 'Повна ціна', 'Податки, доставка, монтаж:\nщо вже входить у пропозицію?'),
         ('03', 'Строк дії', 'До якої дати діє ціна\nта чи є товар у наявності?')]
for i, (number, heading, body) in enumerate(items):
    y = 500 + i * 216
    d.rounded_rectangle((64, y, 145, y + 68), radius=18, fill=ORANGE)
    text(d, (78, y + 14), number, 32, bold=True)
    text(d, (173, y), heading, 47, bold=True)
    text(d, (173, y + 72), body, 35, MUTED)
im.save(OUT / '02-check.png')

im, d = base(3, 'Навчальний приклад')
text(d, (64, 240), 'А якщо ціни\nзміняться?', 80, bold=True)
text(d, (64, 474), 'Покупки: 98 000 грн', 45)
text(d, (64, 548), '+10% → ще 9 800 грн', 45)
text(d, (64, 622), 'Доставка: 2 000 грн', 45)
d.rounded_rectangle((64, 736, 1016, 916), radius=32, fill=INK)
text(d, (102, 777), '109 800 грн', 91, CREAM, True)
text(d, (64, 964), 'Умовні цифри, не прогноз цін.\nДопустимість витрат перевіряйте\nза умовами своєї програми.', 35, MUTED)
text(d, (64, 1110), 'Приклад і таблиця — за посиланням у дописі', 33, bold=True)
im.save(OUT / '03-scenario.png')

thumbs = []
for name in ['01-hook.png', '02-check.png', '03-scenario.png']:
    t = Image.open(OUT / name)
    t.thumbnail((360, 450))
    thumbs.append(t)
contact = Image.new('RGB', (1080, 450), '#D7DCD5')
for i, t in enumerate(thumbs):
    contact.paste(t, (i * 360, 0))
contact.save(OUT / 'preview.jpg', quality=92)
print('Created three 1080x1350 cards and preview.jpg')
