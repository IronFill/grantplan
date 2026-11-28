"""Render the GrantPlan workshop cashflow short."""
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
    cafe.label(draw, (54, 211), "НАВЧАЛЬНИЙ ПРИКЛАД · МАЙСТЕРНЯ", 23, cafe.MUTED, True)

    if t < 3:
        cafe.label(draw, (54, 340), "Обладнання", 74, bold=True)
        cafe.label(draw, (54, 428), "купили.", 74, bold=True)
        cafe.label(draw, (54, 554), "А якщо замовлень", 59, cafe.ORANGE, True)
        cafe.label(draw, (54, 631), "менше?", 75, cafe.ORANGE, True)
    elif t < 9:
        cafe.label(draw, (54, 328), "Залишок за 6 місяців", 53, bold=True)
        scenarios = [(461, "За планом", "110 000 грн", cafe.WHITE, "#202936")]
        if t >= 4.6:
            scenarios.append((615, "Надходження −30%", "11 000 грн", cafe.ORANGE, "#39241c"))
        for y, title, amount, color, background in scenarios:
            draw.rounded_rectangle((54, y, 648, y + 128), 20, fill=background)
            cafe.label(draw, (78, y + 16), title, 29, cafe.MUTED)
            cafe.label(draw, (78, y + 53), amount, 48, color, True)
        cafe.label(draw, (54, 820), "50 000 грн після закупівлі", 34, cafe.MUTED)
    else:
        cafe.label(draw, (54, 362), "Перевірте", 86, bold=True)
        cafe.label(draw, (54, 463), "запас грошей.", 75, cafe.ORANGE, True)
        draw.rounded_rectangle((54, 701, 648, 790), 19, fill=cafe.ORANGE)
        cafe.label(draw, (76, 721), "grantplan.com.ua/cashflow", 43, "#11151d", True)
        cafe.label(draw, (54, 830), "Прогноз на шість місяців", 34, cafe.MUTED)
    return image


if __name__ == "__main__":
    cafe.render(frame, "GrantPlan-cashflow-workshop-12s.mp4", (0, 3, 4.6, 9))
