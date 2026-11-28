"""Render the campaign's QR-linked videos and companion card."""
import importlib

import qrcode
from PIL import Image, ImageDraw

cafe = importlib.import_module("render-cashflow-cafe")
URL = "https://grantplan.com.ua/cashflow/"


def qr_code(scale):
    code = qrcode.QRCode(box_size=scale, border=4)
    code.add_data(URL)
    return code.make_image(fill_color="black", back_color="white").convert("RGB")


def render_video(name, cues):
    source = importlib.import_module(f"render-cashflow-{name}")
    qr = qr_code(6)

    def frame(t):
        image = source.frame(t)
        if t >= 9:
            image.paste(qr, (54, 914))
        return image

    cafe.render(frame, f"GrantPlan-cashflow-{name}-12s.mp4", cues)


def render_card():
    image = Image.new("RGB", (720, 900), "#11151d")
    draw = ImageDraw.Draw(image)
    cafe.label(draw, (52, 44), "ГРАНТПЛАН", 33, cafe.ORANGE, True)
    cafe.label(draw, (52, 116), "Відкриття затрималось.", 49, bold=True)
    cafe.label(draw, (52, 185), "Оренда — ні.", 64, cafe.ORANGE, True)
    cafe.label(draw, (52, 280), "НАВЧАЛЬНИЙ ПРИКЛАД · КАВ’ЯРНЯ", 25, cafe.MUTED, True)
    for y, name, amount in [
        (351, "Після закупівлі", "60 000 грн"),
        (430, "Місяць 1", "20 000 грн"),
        (509, "Місяць 2", "−20 000 грн"),
    ]:
        draw.rounded_rectangle((52, y, 666, y + 67), 12, fill="#202936")
        cafe.label(draw, (70, y + 14), name, 30, cafe.MUTED)
        cafe.label(draw, (400, y + 11), amount, 34, cafe.ORANGE if y == 509 else cafe.WHITE, True)
    image.paste(qr_code(5), (52, 632))
    cafe.label(draw, (260, 652), "Перевірте свій", 36, bold=True)
    cafe.label(draw, (260, 701), "запас грошей", 36, bold=True)
    cafe.label(draw, (260, 768), "grantplan.com.ua/cashflow", 28, cafe.ORANGE, True)
    image.save(cafe.ROOT / "GrantPlan-cashflow-card-qr.png")


if __name__ == "__main__":
    render_card()
    render_video("cafe", (0, 1, 3, 4.35, 5.7, 9))
    render_video("salon", (0, 3, 6, 9))
    render_video("workshop", (0, 3, 4.6, 9))
