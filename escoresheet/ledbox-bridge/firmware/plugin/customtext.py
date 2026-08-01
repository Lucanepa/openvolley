# uncompyle6 version 3.7.4
# Python bytecode 2.7 (62211)
# Decompiled from: Python 2.7.16 (default, Oct 10 2019, 22:02:15) 
# [GCC 8.3.0]
# Embedded file name: customtext.py
# Compiled at: 2021-02-18 07:58:54
import threading, ledboxApp as app, json, time, os
from LedboxPlugin import LedboxPlugin
import ErrorMessage

class customtextPlugin(LedboxPlugin):
    _STATUS_STOP = 0
    _STATUS_PLAY = 1
    _STATUS_PAUSE = 2
    current_customtextname = ''
    current_status = 0
    _current_customtext = None
    _thread_customtext = None

    def __init__(self, version=0.1):
        self.current_customtextname = ''
        LedboxPlugin.__init__(self, version)

    def StartCustomText(self, value=None):
        if 'title' not in value['value']:
            return ErrorMessage.getMessage(9, 'title')
        else:
            data = {}
            if value == None:
                self.start()
                data['hashname'] = self.current_customtextname
                data['title'] = self.current_customtextname
            else:
                self.start(value['value'])
                data['hashname'] = value['value']['title']
                data['title'] = value['value']['title']
            return data

    def PauseCustomText(self, value=None):
        data = {}
        data['hashname'] = self.current_customtextname
        data['title'] = self.current_customtextname
        self.pause()
        return data

    def StopCustomText(self, value):
        data = {}
        data['hashname'] = self.current_customtextname
        data['title'] = self.current_customtextname
        self.stop()
        return data

    def start(self, data=None):
        if self._current_customtext != None:
            if data == None:
                data_title = self._current_customtext.customtextname
            else:
                data_title = data['title']
            if self._current_customtext.customtextname == data_title:
                self._current_customtext.resume()
                app.Debug('RESUME CUSTOMTEXT')
            else:
                self.stop()
                data = {}
                data['status'] = 'ok'
                data['sender'] = 'StopCustomText'
                data_value = {}
                data_value['hashname'] = self._current_customtext.customtextname
                data_value['title'] = self._current_customtext.customtextname
                data['value'] = data_value
                app.resendMessageBroadcast(json.dumps(data), 'ledbox')
                self.start(data['title'])
        else:
            self.stop()
            self._current_customtext = ThreadCustomText(data)
            self.current_customtextname = data['title']
            self._thread_customtext = threading.Thread(target=self._current_customtext.run, args=())
            self._thread_customtext.start()
        self.current_status = self._STATUS_PLAY
        return

    def stop(self):
        if self._thread_customtext != None:
            self._current_customtext.stop()
        self._thread_customtext = None
        self._current_customtext = None
        self.current_customtextname = ''
        self.current_status = self._STATUS_STOP
        app.current_layout = app.layoutManager.loadLayout('waiting')
        return

    def pause(self):
        if self._current_customtext != None:
            self._current_customtext.pause()
            self.current_status = self._STATUS_PAUSE
        return


class ThreadCustomText(threading.Thread):
    _pause = False
    customtextname = ''

    def __init__(self, customtext):
        threading.Thread.__init__(self)
        self._stop_event = threading.Event()
        self.customtext = customtext
        self.customtextname = customtext['title']

    def stop(self):
        self._stop_event.set()

    def stopped(self):
        return self._stop_event.is_set()

    def resume(self):
        self._pause = False

    def pause(self):
        self._pause = True

    def run(self):
        app.current_layout = app.layoutManager.loadLayout('custom_text')
        section = app.current_layout.getSection('custom')
        section.setx(0)
        section.sety(0)
        section.setX(0)
        section.setY(0)
        section.animation = ''
        section.animation_params = {}
        print (self.customtext['text'])
        size = app.LEDMatrix2.calculateLenghtText(self.customtext['text'], self.customtext['fontsize'])
        text_width = size[0]
        text_height = size[1]
        i = 0
        while not self.stopped():
            if self._pause == True:
                continue
            app.current_layout.setSection('custom', 'text', self.customtext['text'])
            app.current_layout.setSection('custom', 'fontsize', self.customtext['fontsize'])
            app.current_layout.setSection('custom', 'color', self.customtext['color'])
            if self.customtext['animation'] == 'scroller_x_lr' or self.customtext['animation'] == 'scroller_x_rl':
                section = app.current_layout.getSection('custom')
                section.animation = ''
                section.animation_params = {}
                x = section.getx()
                if self.customtext['animation'] == 'scroller_x_rl':
                    if -x > text_width:
                        section.setX(192)
                    else:
                        section.setX(x - 1)
                if self.customtext['animation'] == 'scroller_x_lr':
                    if x > 192:
                        section.setX(-text_width)
                    else:
                        section.setX(x + 1)
            if self.customtext['animation'] == 'scroller_y_tb' or self.customtext['animation'] == 'scroller_y_bt':
                section = app.current_layout.getSection('custom')
                section.animation = ''
                section.animation_params = {}
                y = section.gety()
                if self.customtext['animation'] == 'scroller_y_tb':
                    if y > 64:
                        section.setY(-text_height)
                    else:
                        section.setY(y + 1)
                if self.customtext['animation'] == 'scroller_y_bt':
                    if y < -text_height:
                        section.setY(64)
                    else:
                        section.setY(y - 1)
            if self.customtext['animation'] == 'blinking':
                section.animation = 'blinking'
                t = 1000 / int(self.customtext['animation_velocity'])
                section.animation_params['pause'] = t
                section.setX(0)
                section.setY(0)
            if self.customtext['animation'] == '':
                section.animation = ''
                section.animation_params = {}
            time.sleep(0.1 / int(self.customtext['animation_velocity']))