# uncompyle6 version 3.7.4
# Python bytecode 2.7 (62211)
# Decompiled from: Python 2.7.16 (default, Oct 10 2019, 22:02:15) 
# [GCC 8.3.0]
# Embedded file name: practice.py
# Compiled at: 2021-02-18 07:58:54
import threading, ledboxApp as app, json, time, os, ErrorMessage, shutil
from LedboxPlugin import LedboxPlugin

class practicePlugin(LedboxPlugin):
    _STATUS_STOP = 0
    _STATUS_PLAY = 1
    _STATUS_PAUSE = 2
    current_practicename = ''
    current_practicetitle = ''
    current_status = 0
    _current_practice = None
    _thread_practice = None

    def __init__(self, version=0.1):
        self.current_practicename = ''
        self.current_practicetitle = ''
        LedboxPlugin.__init__(self, version)

    def SetPractice(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        else:
            if 'sport' not in value:
                return ErrorMessage.getMessage(9, 'sport')
            if 'hashname' not in value['value']:
                return ErrorMessage.getMessage(9, 'hashname')
            if self._current_practice != None:
                data = {}
                data['status'] = 'ok'
                data['sender'] = 'StopPractice'
                result = {}
                result['hashname'] = self._current_practice.practicename
                result['title'] = self._current_practice.practicetitle
                data['value'] = result
                app.sendToClients(json.dumps(data))
                self.stop()
            val = value['value']
            path = app.API.CreateFolderAlias(value['alias'], value['sport']) + '/practice'
            if os.path.isdir(path) == False:
                os.mkdir(path)
            path = path + '/practice_' + val['hashname'] + '.json'
            file = open(path, 'wb')
            file.write(bytes(json.dumps(val),'utf-8'))
            file.close()
            return val

    def StartPractice(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        if 'hashname' not in value['value']:
            return ErrorMessage.getMessage(9, 'hashname')
        self.start(value)
        result = {}
        result['hashname'] = value['value']['hashname']
        result['title'] = self.current_practicetitle
        return result

    def StopPractice(self, value):
        result = {}
        result['hashname'] = self.current_practicename
        result['title'] = self.current_practicetitle
        self.stop()
        return result

    def PausePractice(self, value):
        if 'hashname' not in value['value']:
            return ErrorMessage.getMessage(9, 'hashname')
        result = {}
        result['hashname'] = value['value']['hashname']
        result['title'] = self.current_practicetitle
        self.pause()
        return result

    def GetListPractice(self, value):
        listPractice = []
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        else:
            if 'sport' not in value:
                return ErrorMessage.getMessage(9, 'sport')
            path_media = 'media/' + value['alias'] + '/' + value['sport'] + '/practice'
            if os.path.isdir(path_media) == False:
                return listPractice
            for f in os.listdir(path_media):
                filename, extension = os.path.splitext(f)
                if extension == '.json':
                    filetype, name = filename.split('_')
                    if filetype == 'practice':
                        file_stats=os.stat(path_media + '/' + f)
                        if(file_stats.st_size>0):
                            filejson = open(path_media + '/' + f, 'r')
                        
                            practice = json.loads(filejson.read())
                            filejson.close()
                            if 'Title' in practice:
                                title = practice['Title']
                            if 'title' in practice:
                                title = practice['title']
                            data = {}
                            data['title'] = title
                            data['hashname'] = practice['hashname']
                            if self._current_practice != None and name == self._current_practice.practicename:
                                data['current_status'] = self.current_status
                            else:
                                data['current_status'] = 0
                            listPractice.append(data)

            return listPractice

    def DeleteAllPractice(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        path_media = 'media/' + value['alias'] + '/' + value['sport'] + '/practice/'
        shutil.rmtree(path_media)
        return True

    def UploadPractice(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        path = app.API.CreateFolderAlias(value['alias'], value['sport'])
        path = path + '/practice'
        if os.path.isdir(path) == False:
            os.mkdir(path)
        value = value['value']
        if 'filename' not in value:
            return ErrorMessage.getMessage(9, 'filename')
        requestToUpload = value
        typeToUpload = 'media'
        filepathToUpload = path + '/' + value['filename']
        app.setUploadClient(self._clientid, filepathToUpload, typeToUpload, requestToUpload)
        exist = False
        if os.path.exists(os.path.abspath(filepathToUpload)):
            exist = True
        value['exist'] = exist
        return value

    def start(self, value):
        practicename = value['value']['hashname']
        if self._current_practice != None and self._current_practice.getPauseStatus() == True:
            if self._current_practice.practicename == practicename:
                self._current_practice.resume()
                app.Debug('RESUME PLAYLIST')
            else:
                self.stop()
                data = {}
                data['status'] = 'ok'
                data['sender'] = 'StopPractice'
                result = {}
                result['hashname'] = self.current_practicename
                result['title'] = self.current_practicetitle
                data['value'] = result
                app.sendToClients(json.dumps(data))
                self.start(practicename)
        else:
            self.stop()
            path = 'media/' + value['alias'] + '/' + value['sport'] + '/practice/'
            filepath = path + 'practice_' + practicename + '.json'
            if os.path.isfile(filepath):
                filejson = open(filepath, 'r')
                practice = json.loads(filejson.read())
                filejson.close()
                app.current_layout = app.layoutManager.loadLayout('practice')
                self._current_practice = ThreadPractice(practicename, practice['title'], path, self)
                self.current_practicename = practicename
                self.current_practicetitle = practice['title']
                self._thread_practice = threading.Thread(target=self._current_practice.run, args=())
                self._thread_practice.start()
        self.current_status = self._STATUS_PLAY
        return

    def stop(self):
        if self._current_practice != None and self._current_practice != '':
            self._current_practice.stop()
            self._thread_practice = None
            app.current_layout = app.layoutManager.loadLayout('waiting')
        self._current_practice = None
        self.current_practicename = ''
        self.current_status = self._STATUS_STOP
        return

    def pause(self):
        if self._current_practice != None:
            self._current_practice.pause()
            self.current_status = self._STATUS_PAUSE
        return


class ThreadPractice(threading.Thread):
    _pause = False
    practicename = ''
    practicetitle = ''
    path = ''

    def __init__(self, practicename, practicetitle, path, practiceClass):
        threading.Thread.__init__(self)
        self._stop_event = threading.Event()
        self.practicename = practicename
        self.practicetitle = practicetitle
        self.path = path
        self.practiceClass = practiceClass

    def stop(self):
        self._stop_event.set()

    def getPauseStatus(self):
        return self._pause

    def resume(self):
        self._pause = False

    def pause(self):
        self._pause = True

    def stopped(self):
        return self._stop_event.is_set()

    def setColor(self, color):
        app.current_layout.setSection('timer', 'color', color)
        app.current_layout.setSection('status', 'color', color)

    def getSound(self, idx):
        short_time = 0.4
        long_time = 0.8
        data = {}
        if idx == 0:
            data['times'] = 0
            data['sleep'] = 0
        if idx == 1:
            data['times'] = 1
            data['sleep'] = short_time
        if idx == 2:
            data['times'] = 2
            data['sleep'] = short_time
        if idx == 3:
            data['times'] = 3
            data['sleep'] = short_time
        if idx == 4:
            data['times'] = 1
            data['sleep'] = long_time
        if idx == 5:
            data['times'] = 2
            data['sleep'] = long_time
        if idx == 6:
            data['times'] = 3
            data['sleep'] = long_time
        return data

    def setRest(self):
        app.current_layout.setSection('status', 'text', 'setup')
        self.setColor('255,0,0')

    def setWork(self):
        app.current_layout.setSection('status', 'text', 'work')
        self.setColor('0,255,0')

    def run(self):
        lamp = True
        filepath = self.path + 'practice_' + self.practicename + '.json'
        totalCounter = 0
        if os.path.isfile(filepath):
            filejson = open(filepath, 'r')
            practice = json.loads(filejson.read())
            filejson.close()
            app.current_layout.setSection('timer', 'text', '')
            if 'Items' in practice:
                items = playlist['Items']
            if 'items' in practice:
                items = practice['items']
            for i in range(0, len(items)):
                file = items[i]
                while self._pause == True:
                    time.sleep(0.001)

                for r in range(0, file['round']):
                    while self._pause == True:
                        time.sleep(0.001)

                    app.current_layout.setSection('round', 'text', str(r + 1) + '/' + str(file['round']))
                    self.setRest()
                    counter_time = 0
                    state = 'rest'
                    remaing_time = file[state]
                    while not self.stopped():
                        if self._pause == True:
                            continue
                        if lamp == True:
                            app.current_layout.setSection('circle', 'color', '255,255,255')
                            lamp = False
                        else:
                            app.current_layout.setSection('circle', 'color', '0,0,0')
                            lamp = True
                        if state == 'work':
                            if counter_time > file[state]:
                                data = {}
                                data_value = {}
                                sound = self.getSound(int(file['soundwork']))
                                data_value['times'] = sound['times']
                                data_value['sleep'] = sound['sleep']
                                data['value'] = data_value
                                app.API.Horn(data)
                                if r + 1 == file['round']:
                                    counter_time = 0
                                    break
                        if remaing_time == 0:
                            app.current_layout.setSection('timer', 'text', '')
                        else:
                            if remaing_time > 60:
                                app.current_layout.setSection('formattime', 'text', 'min')
                                t = str(int(remaing_time / 60))
                            else:
                                app.current_layout.setSection('formattime', 'text', 'sec')
                                t = time.strftime('%S', time.gmtime(remaing_time))
                            app.current_layout.setSection('timer', 'text', t)
                        percentualComplete = int(float(totalCounter) / float(practice['totalduration']) * 100)
                        app.current_layout.setSection('progress', 'text', str(percentualComplete) + '%')
                        remaing_time = remaing_time - 1
                        if remaing_time == -1:
                            if state == 'rest':
                                data = {}
                                data_value = {}
                                sound = self.getSound(int(file['soundrest']))
                                data_value['times'] = sound['times']
                                data_value['sleep'] = sound['sleep']
                                data['value'] = data_value
                                app.API.Horn(data)
                                state = 'work'
                                self.setWork()
                            else:
                                break
                            remaing_time = file[state]
                            counter_time = 0
                        file_path = self.path + file['filename']
                        if not self.stopped():
                            file_path = self.path + file['filename']
                            try:
                                if os.path.isfile(file_path):
                                    if file['type'] == 2:
                                        mp3 = app.start_playmusic(file_path, 0.8)
                                    else:
                                        if file['type'] == 0:
                                            app.current_layout.setSection('media', 'type', 'image')
                                            app.current_layout.setSection('media', 'src', file_path)
                                        if file['type'] == 1:
                                            app.current_layout.setSection('media', 'type', 'video')
                                            app.current_layout.setSection('media', 'src', file_path)
                                time.sleep(1)
                                counter_time = counter_time + 1
                                totalCounter = totalCounter + 1
                            except:
                                print ('error practice ' + file['filename'])

            data = {}
            data['status'] = 'ok'
            data['sender'] = 'StopPractice'
            result = {}
            result['hashname'] = self.practicename
            result['title'] = practice['title']
            data['value'] = result
            app.sendToClients(json.dumps(data))
            self.practiceClass.stop()