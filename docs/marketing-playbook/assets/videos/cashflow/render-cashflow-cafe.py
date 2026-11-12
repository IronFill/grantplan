"""Render the GrantPlan cafe short with Pillow and imageio-ffmpeg."""
from pathlib import Path
import math
import struct
import subprocess
import tempfile
import wave

from PIL import Image, ImageDraw, ImageFont
from imageio_ffmpeg import get_ffmpeg_exe

ROOT = Path(__file__).resolve().parent
W, H, FPS, DURATION = 720, 1280, 30, 12
ORANGE, WHITE, MUTED = "#ff993e", "#f5f2eb", "#b8bdc8"
FONT_PATH = Path("C:/Windows/Fonts")
FONTS = {}


def label(draw, xy, content, size, color=WHITE, bold=False):
    key = (size, bold)
    if key not in FONTS:
        FONTS[key] = ImageFont.truetype(str(FONT_PATH / ("segoeuib.ttf" if bold else "segoeui.ttf")), size)
    draw.text(xy, content, font=FONTS[key], fill=color)


def frame(t):
    image = Image.new("RGB", (W, H), "#11151d")
    draw = ImageDraw.Draw(image)
    for y in range(0, H, 48):
        draw.line((0, y, W, y), fill="#181e28")
    draw.rounded_rectangle((54, 118, 104, 127), 4, fill=ORANGE)
    label(draw, (54, 146), "ГРАНТПЛАН", 33, ORANGE, True)
    label(draw, (54, 211), "НАВЧАЛЬНИЙ ПРИКЛАД · КАВ’ЯРНЯ", 23, MUTED, True)
    if t < 3:
        label(draw, (54, 343), "Відкриття", 87, bold=True)
        label(draw, (54, 442), "затрималось.", 86, bold=True)
        if t >= 1:
            label(draw, (54, 564), "Оренда — ні.", 78, ORANGE, True)
        label(draw, (54, 755), "Два місяці без продажів", 39, MUTED)
    elif t < 9:
        label(draw, (54, 300), "Залишок грошей", 57, bold=True)
        for index, (caption, value) in enumerate((("Після закупівлі", "60 000 грн"), ("Місяць 1", "20 000 грн"), ("Місяць 2", "−20 000 грн"))):
            if t < (3, 4.35, 5.7)[index]:
                continue
            y = 419 + 136 * index
            fill = "#39241c" if index == 2 else "#202936"
            draw.rounded_rectangle((54, y, 649, y + 114), 20, fill=fill)
            label(draw, (78, y + 37), caption, 31, MUTED)
            label(draw, (349, y + 29), value, 48, ORANGE if index == 2 else WHITE, True)
        if t >= 5.7:
            label(draw, (54, 856), "Постійні виплати · 40 000 грн/міс.", 30, MUTED)
    else:
        label(draw, (54, 344), "Перевірте", 86, bold=True)
        label(draw, (54, 443), "свій запас", 86, bold=True)
        label(draw, (54, 542), "грошей.", 86, ORANGE, True)
        draw.rounded_rectangle((54, 728, 648, 817), 19, fill=ORANGE)
        label(draw, (76, 748), "grantplan.com.ua/cashflow", 43, "#11151d", True)
        label(draw, (54, 852), "Прогноз на шість місяців", 34, MUTED)
    draw.rounded_rectangle((54, 1034, 649, 1041), 3, fill="#343c49")
    draw.rectangle((54, 1034, 54 + int(595 * t / DURATION), 1041), fill=ORANGE)
    return image


def soundtrack(path):
    rate = 24000
    cues = (0, 1, 3, 4.35, 5.7, 9)
    samples = bytearray()
    for i in range(rate * DURATION):
        t = i / rate
        beat = t % 0.5
        bass = 0.07 * math.exp(-9 * beat) * math.sin(math.tau * 65.4 * t)
        accents = sum(
            0.16 * math.exp(-24 * (t - cue)) * math.sin(math.tau * (165 if cue == 5.7 else 330) * (t - cue))
            for cue in cues if 0 <= t - cue < 0.26
        )
        samples.extend(struct.pack("<h", int(32767 * (bass + accents) * min(1, (12 - t) * 5))))
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(samples)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as scratch:
        audio = Path(scratch) / "sound.wav"
        soundtrack(audio)
        output = ROOT / "GrantPlan-cashflow-cafe-12s.mp4"
        command = [get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                   "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", str(audio), "-c:v", "libx264",
                   "-pix_fmt", "yuv420p", "-crf", "19", "-c:a", "aac", "-movflags", "+faststart", str(output)]
        with subprocess.Popen(command, stdin=subprocess.PIPE) as encoder:
            for index in range(FPS * DURATION):
                encoder.stdin.write(frame(index / FPS).tobytes())
            encoder.stdin.close()
            if encoder.wait() != 0:
                raise RuntimeError("Video encoding failed")
        frame(7).save(ROOT / "cashflow-cafe-video-preview.png")
