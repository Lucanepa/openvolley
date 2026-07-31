# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: LEDMatrix2.py
# Compiled at: 2021-08-30 23:16:21
from PIL import Image, ImageFile, ImageFont, ImageDraw
import time, ledboxApp as app, threading, cv2, os, mimetypes, copy
ImageFile.LOAD_TRUNCATED_IMAGES = True
path_font = 'fonts/ARIAL.TTF'
buffer = Image.new('RGB', (192, 64))
offset_x = 0
offset_y = 0
thread_ledmatrix = None
current_video_name = None
tmp_second = 0
millisecond_frame = 0
fps = 0.01

def init():
    global fps
    if app.Config.getfloat('LEDBOX', 'version_hw') < 0.44:
        fps = 0.2
    thread_ledmatrix.start()
    return


def printLayout():
    try:
        buffer = Image.new('RGB', (192, 64))
        for section in app.current_layout.sections:
            if section.typesection == 'text':
                buffer = printText(section, buffer)
            if section.typesection == 'counter':
                buffer = printCounter(section, buffer)
            if section.typesection == 'image' or section.typesection == 'video':
                buffer = printMedia(section, buffer)
            if section.typesection == 'rectangle':
                buffer = printRectangle(section, buffer)
            if section.typesection == 'circle':
                buffer = printCircle(section, buffer)

        if app.widthOut != 192:
            buffer = buffer.resize((app.widthOut, app.heightOut), Image.LANCZOS)
        buffer.save('www/buffer.png')
        buffer_compressed = buffer.resize((96, 32), Image.LANCZOS)
        buffer_compressed.save('www/buffer_compressed.png', quality=95)
        return buffer
    except Exception as e:
        app.Debug(str(e))
        print(e)

    return


def printText(section, img):
    fnt = ImageFont.truetype(path_font, int(section.fontsize))
    d = ImageDraw.Draw(img)
    if section.text == '':
        return img
    else:
        if section.visible == False:
            return img
        else:
            text_to_draw = copy.copy(section.text)
            if section.maxlength > 0:
                if len(section.text) > section.maxlength:
                    text_to_draw = copy.copy(section.text[0:section.maxlength])
            # (py2 transcoded utf8->latin1 here; under py3 section.text is already str,
            # which is what Pillow wants -- and it keeps umlauts working: Zurich, Kussnacht.)
            size = calculateLenghtText(text_to_draw, int(section.fontsize))
            color = section.color
            if section.animation == 'scroller_x':
                if section.getx() > section.getX() + section.width:
                    section.setx(section.getX() - size[0])
                else:
                    section.setx(section.getx() + 1)
                app.current_layout.ischange = True
            if section.animation == 'scroller_y':
                if section.gety() > section.getY() + section.height:
                    section.sety(section.getY() - size[1])
                else:
                    section.sety(section.gety() + 1)
                app.current_layout.ischange = True
            if section.animation == '':
                section.sety(section.getY())
                section.setx(section.getX())
            if section.animation == 'blinking':
                color = getColorBlinking(section)
            if color == None:
                color = section.color
            x = 0
            y = 0
            if section.align == 'left':
                x = section.getx()
                y = section.gety()
            if section.align == 'center':
                x = section.getx() - size[0] / 2
                y = section.gety()
            if section.align == 'right':
                x = section.getx() - size[0]
                y = section.gety()
            d.text((offset_x + x, offset_y + y), text_to_draw, font=fnt, align=section.align, fill=color)
            return img

        return


def printCounter(section, img):
    global millisecond_frame
    if 'format' not in section.parameter:
        section.parameter['format'] = '%S'
    if 'time' not in section.parameter:
        section.parameter['time'] = millisecond_frame
    if 'start' not in section.parameter:
        section.parameter['start'] = 0
    if 'stop' not in section.parameter:
        section.parameter['stop'] = 30
    if 'type' not in section.parameter:
        section.parameter['type'] = 'countup'
    if 'last_time' not in section.parameter:
        section.parameter['last_time'] = section.parameter['start']
    if millisecond_frame - section.parameter['time'] > 1000 and section.enable == True:
        section.parameter['time'] = millisecond_frame
        if section.parameter['type'] == 'countup':
            if section.parameter['last_time'] < section.parameter['stop']:
                section.parameter['last_time'] = section.parameter['last_time'] + 1
            else:
                section.enable = False
        if section.parameter['type'] == 'countdown':
            if section.parameter['last_time'] > section.parameter['stop']:
                section.parameter['last_time'] = section.parameter['last_time'] - 1
            else:
                section.enable = False
    if section.parameter['format'] == '%TM':
        total_minute = section.parameter['last_time'] // 60
        total_second = section.parameter['last_time'] % 60
        timestr = str(total_minute).zfill(2) + ':' + str(total_second).zfill(2)
        section.text = timestr
    else:
        section.text = time.strftime(section.parameter['format'], time.gmtime(section.parameter['last_time']))
    img = printText(section, img)
    return img


def printMedia(section, img):
    if section.visible == False:
        return img
    else:
        if 'media/' in section.src:
            filepath = section.src
        else:
            filepath = 'media/' + section.src
        try:
            if section.src == '' or os.path.isfile(filepath) == False:
                return img
            if section.typesection == 'image':
                img_to_paste = Image.open(filepath)
                section.current_video_name = filepath
                is_animated = False
                try:
                    is_animated = img_to_paste.is_animated
                except:
                    is_animated = False

                if is_animated == True:
                    if section.video == None:
                        section.video = Image.open(filepath, 'r')
                    if 'time' not in section.animation_params:
                        section.animation_params['time'] = millisecond_frame
                    if millisecond_frame - section.animation_params['time'] > 50:
                        section.animation_params['time'] = millisecond_frame
                        if section.frame < section.video.n_frames:
                            section.frame = section.frame + 1
                            try:
                                section.video.seek(section.video.tell() + 1)
                            except EOFError:
                                section.video = Image.open(filepath, 'r')

                        else:
                            section.frame = 0
                    img_to_paste = section.video.convert('RGB')
            else:
                if section.video == None:
                    section.video = cv2.VideoCapture(filepath)
                section.video.set(1, section.frame)
                ret, img_to_paste = section.video.read()
                section.frame = section.frame + 1
                img_to_paste = Image.fromarray(img_to_paste)
            if img_to_paste.mode != 'RGB':
                img_to_paste = img_to_paste.convert('RGB')
            img_to_paste.thumbnail((section.width, section.height))
            off_align_x = 0
            off_align_y = 0
            if section.align == 'left':
                off_align_x = 0
            if section.align == 'center':
                off_align_x = -img_to_paste.width // 2
            if section.align == 'right':
                off_align_x = -img_to_paste.width
            if section.valign == 'top':
                off_align_y = 0
            if section.valign == 'center':
                off_align_y = -img_to_paste.height // 2
            if section.valign == 'bottom':
                off_align_y = -img_to_paste.height
            img.paste(img_to_paste, (int(offset_x + section.getx() + off_align_x), int(offset_y + section.gety() + off_align_y)))
        except Exception as e:
            app.Debug('Print media ' + str(e))
            section.frame = 0

        return img
        return


def printRectangle(section, img):
    if section.visible == False:
        return img
    else:
        color = section.color
        bordercolor = section.bordercolor
        if section.color == '':
            return img
        if section.animation == 'blinking':
            color = getColorBlinking(section)
        if section.animation == 'blinkingborder':
            bordercolor = getColorBlinking(section)
        if color == None:
            color = section.color
        if bordercolor == None:
            bordercolor = section.bordercolor
        d = ImageDraw.Draw(img)
        d.rectangle([(offset_x + section.getx(), offset_y + section.gety()), (offset_x + section.getx() + section.width, offset_y + section.gety() + section.height)], fill=color, outline=bordercolor)
        return img
        return


def printCircle(section, img):
    if section.visible == False:
        return img
    else:
        color = section.color
        bordercolor = section.bordercolor
        if section.animation == 'blinking':
            color = getColorBlinking(section)
        if section.animation == 'blinkingborder':
            bordercolor = getColorBlinking(section)
        if color == None:
            color = section.color
        if bordercolor == None:
            bordercolor = section.bordercolor
        d = ImageDraw.Draw(img)
        d.ellipse([(offset_x + section.getx(), offset_y + section.gety()), (offset_x + section.getx() + section.width, offset_y + section.gety() + section.height)], fill=color, outline=bordercolor)
        return img
        return


def run():
    global millisecond_frame
    while True:
        buffer = printLayout()
        millisecond_frame = int(round(time.time() * 1000))
        time.sleep(fps)

    return


def getColorBlinking(section):
    if 'color' not in section.animation_params:
        section.animation_params['color'] = 1
    if 'color1' not in section.animation_params or section.animation_params['color1'] == '':
        section.animation_params['color1'] = section.getColorString()
    if 'color2' not in section.animation_params or section.animation_params['color2'] == '':
        section.animation_params['color2'] = '0,0,0'
    if 'time' not in section.animation_params:
        section.animation_params['time'] = millisecond_frame
        section.animation_params['color'] = 1
    if 'pause' not in section.animation_params:
        section.animation_params['pause'] = 500
    if 'count' in section.animation_params and section.animation_params['count'] != 0:
        if 'current_frame' not in section.animation_params:
            section.animation_params['current_frame'] = 0
    if millisecond_frame - section.animation_params['time'] > section.animation_params['pause']:
        if 'count' in section.animation_params and section.animation_params['count'] != 0:
            if section.animation_params['current_frame'] > section.animation_params['count'] * 2 - 1:
                section.animation = ''
                del section.animation_params['time']
                del section.animation_params['current_frame']
                section.animation_params['color'] = 1
                return
        section.animation_params['time'] = millisecond_frame
        if section.animation_params['color'] == 1:
            section.animation_params['color'] = 2
        else:
            section.animation_params['color'] = 1
        if 'count' in section.animation_params and section.animation_params['count'] != 0:
            section.animation_params['current_frame'] = section.animation_params['current_frame'] + 1
    return app.current_layout.getColor(section.animation_params['color' + str(section.animation_params['color'])])


def calculateLenghtText(text, fontsize):
    img_tmp = Image.new('RGB', (192, 64))
    fnt = ImageFont.truetype(path_font, int(fontsize))
    d = ImageDraw.Draw(img_tmp)
    size = d.textsize(text, font=fnt)
    return size


thread_ledmatrix = threading.Thread(target=run, args=())
