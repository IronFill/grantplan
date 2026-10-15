"""Render original text-only GrantPlan cards. Requires Pillow; no network calls."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json

ROOT = Path(__file__).parent
W,H=1080,1350
BG='#121B20'; PANEL='#1D2A31'; INK='#F6F4ED'; MUTED='#B9C6CB'; ORANGE='#FF931E'
FONT=Path('C:/Windows/Fonts')
def font(size,bold=False):
    return ImageFont.truetype(str(FONT/('arialbd.ttf' if bold else 'arial.ttf')),size)
def wrap(draw,text,width,size,bold=False):
    rows=[]
    for para in text.split('\n'):
        line=''
        for word in para.split():
            test=(line+' '+word).strip()
            if draw.textlength(test,font=font(size,bold))>width and line:
                rows.append(line);line=word
            else:line=test
        rows.append(line)
    return rows
def block(draw,text,x,y,width,size,color=INK,bold=False,gap=1.22):
    for line in wrap(draw,text,width,size,bold):
        draw.text((x,y),line,font=font(size,bold),fill=color)
        y+=int(size*gap)
    return y
def base(n,kicker,title,sub):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    d.rounded_rectangle((70,65,116,111),radius=12,fill=ORANGE)
    d.text((132,67),'GrantPlan',font=font(38,True),fill=INK)
    d.text((904,73),f'0{n}/03',font=font(25),fill=MUTED)
    d.text((72,177),kicker,font=font(24,True),fill=ORANGE)
    y=block(d,title,68,233,940,73,bold=True,gap=1.12)
    y=block(d,sub,72,y+34,925,32,MUTED)
    assert y<530,(n,y)
    d.line((72,1175,1008,1175),fill='#40515A',width=2)
    d.text((72,1212),'Від ідеї — до плану.',font=font(28,True),fill=INK)
    d.text((72,1260),'grantplan.com.ua',font=font(28),fill=ORANGE)
    return im,d

im,d=base(1,'ПЕРЕД ЗАПУСКОМ БІЗНЕСУ','Ідея — на серветці.\nА бюджет де?','Почніть із трьох розрахунків. Перший — скільки потрібно на старт.')
d.rounded_rectangle((72,558,1008,1055),radius=28,fill=PANEL)
d.text((108,592),'01  СТАРТОВІ ВИТРАТИ',font=font(28,True),fill=ORANGE)
y=block(d,'Обладнання\nОблаштування приміщення\nПерші закупівлі\nІнші витрати до відкриття',108,665,850,38,gap=1.6)
block(d,'Не тільки ціна кавомашини.',108,982,850,28,MUTED)
im.save(ROOT/'01-start.png')

im,d=base(2,'ДРУГИЙ РОЗРАХУНОК','Клієнтів ще мало.\nРахунки — вже є.','Порахуйте витрати місяця роботи й запас коштів до стабільних продажів.')
d.rounded_rectangle((72,558,1008,1055),radius=28,fill=PANEL)
d.text((108,592),'02  МІСЯЦЬ РОБОТИ',font=font(28,True),fill=ORANGE)
block(d,'Оренда та комунальні\nОплата праці\nМатеріали й доставка\nПодатки та інші платежі',108,665,850,38,gap=1.6)
block(d,'Відокремте постійні витрати від тих,\nщо зростають разом із продажами.',108,970,850,26,MUTED)
im.save(ROOT/'02-month.png')

im,d=base(3,'ТРЕТІЙ РОЗРАХУНОК','Скільки замовлень\nпокриють витрати?','Важлива не лише ціна продажу, а й сума, що лишається після змінних витрат.')
d.rounded_rectangle((72,558,1008,1045),radius=28,fill=PANEL)
d.text((108,591),'03  УМОВНИЙ ПРИКЛАД',font=font(28,True),fill=ORANGE)
block(d,'32 000 ₴ / 100 ₴ = 320',108,664,860,53,bold=True)
block(d,'Постійні витрати на місяць / внесок одного\nзамовлення після змінних витрат.',108,751,860,28,MUTED)
block(d,'320 замовлень на місяць —\nщоб покрити ці постійні витрати.',108,853,860,35,bold=True)
block(d,'Приклад, не прогноз. Усі витрати врахуйте один раз.',108,986,860,24,MUTED)
block(d,'Потрібен бізнес-план? Залиште заявку на сайті.',72,1090,936,29,ORANGE,True)
im.save(ROOT/'03-orders.png')
cards=[Image.open(ROOT/name) for name in ['01-start.png','02-month.png','03-orders.png']]
preview=Image.new('RGB',(1080,450),BG)
for n,card in enumerate(cards):
    assert card.size==(1080,1350)
    preview.paste(card.resize((360,450)),(n*360,0))
preview.save(ROOT/'preview.jpg',quality=92)
(ROOT/'validation.json').write_text(json.dumps({'dimensions':[1080,1350],'cards':3,'format':'PNG RGB','formula_check':32000/100==320,'nature':'Original educational example, not grant eligibility or income claim','visual_review':'pending'},ensure_ascii=False,indent=2),encoding='utf-8')
print('Rendered three cards and preview.')
