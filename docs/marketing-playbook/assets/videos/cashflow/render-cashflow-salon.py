"""Render the second GrantPlan cashflow short."""
import importlib

from PIL import Image, ImageDraw

cafe = importlib.import_module("render-cashflow-cafe")


def frame(t):
    image = Image.new("RGB", (cafe.W, cafe.H), "#11151d")
    draw = ImageDraw.Draw(image)
    for y in range(0, cafe.H, 48):
        draw.line((0, y, cafe.W, y), fill="#181e28")
    draw.rounded_rectangle((54, 118, 104, 127), 4, fill=cafe.ORANGE)
    cafe.label(draw, (54, 146), "ГРАНТПЛАН", 33, cafe.ORANGE, True)
    cafe.label(draw, (54, 211), "НАВЧАЛЬНИЙ ПРИКЛАД · САЛОН", 23, cafe.MUTED, True)

    if t < 3:
        cafe.label(draw, (54, 360), "Ремонт готовий.", 70, bold=True)
        cafe.label(draw, (54, 477), "Запис ще", 81, cafe.ORANGE, True)
        cafe.label(draw, (54, 567), "порожній.", 81, cafe.ORANGE, True)
        cafe.label(draw, (54, 755), "Перший місяць без продажів", 38, cafe.MUTED)
    elif t < 6:
        cafe.label(draw, (54, 330), "Перший місяць", 62, bold=True)
        cafe.label(draw, (54, 466), "40 000 грн", 86, bold=True)
        cafe.label(draw, (54, 573), "−30 000 грн виплат", 51, cafe.MUTED)
        cafe.label(draw, (54, 675), "= 10 000 грн", 83, cafe.ORANGE, True)
    elif t < 9:
        cafe.label(draw, (54, 330), "Залишок за 6 місяців", 53, bold=True)
        for y, title, value, highlight in [
            (479, "За планом", "85 000 грн", False),
            (622, "Продажі −20%", "40 000 грн", True),
        ]:
            draw.rounded_rectangle((54, y, 648, y + 115), 20, fill="#39241c" if highlight else "#202936")
            cafe.label(draw, (78, y + 38), title, 32, cafe.MUTED)
            cafe.label(draw, (347, y + 29), value, 48, cafe.ORANGE if highlight else cafe.WHITE, True)
    else:
        cafe.label(draw, (54, 362), "Перевірте", 86, bold=True)
        cafe.label(draw, (54, 463), "запас грошей.", 75, cafe.ORANGE, True)
        draw.rounded_rectangle((54, 701, 648, 790), 19, fill=cafe.ORANGE)
        cafe.label(draw, (76, 721), "grantplan.com.ua/cashflow", 43, "#11151d", True)
        cafe.label(draw, (54, 830), "Прогноз на шість місяців", 34, cafe.MUTED)
    return image


if __name__ == "__main__":
    cafe.render(frame, "GrantPlan-cashflow-salon-12s.mp4", (0, 3, 6, 9))
