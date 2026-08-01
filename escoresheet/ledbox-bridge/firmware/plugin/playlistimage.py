# uncompyle6 version 3.7.4
# Python bytecode 2.7 (62211)
# Decompiled from: Python 2.7.16 (default, Oct 10 2019, 22:02:15) 
# [GCC 8.3.0]
# Embedded file name: playlistimage.py
# Compiled at: 2021-02-18 07:58:54
import threading, ledboxApp as app, json, time, os
from LedboxPlugin import LedboxPlugin
import shutil, ErrorMessage

class playlistimagePlugin(LedboxPlugin):
    _STATUS_STOP = 0
    _STATUS_PLAY = 1
    _STATUS_PAUSE = 2
    current_playlistname = ''
    current_playlisttitle = ''
    current_status = 0
    _current_playlist = None
    _thread_playlist = None

    def __init__(self, version=0.1):
        self.current_playlistname = ''
        self.current_playlisttitle = ''
        LedboxPlugin.__init__(self, version)

    def SetPlaylistImage(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        else:
            if 'sport' not in value:
                return ErrorMessage.getMessage(9, 'sport')
            if 'hashname' not in value['value']:
                return ErrorMessage.getMessage(9, 'hashname')
            if self._current_playlist != None:
                data = {}
                data['status'] = 'ok'
                data['sender'] = 'StopPlaylistImage'
                result = {}
                result['hashname'] = self._current_playlist.playlistname
                result['title'] = self._current_playlist.playlisttitle
                data['value'] = result
                app.resendMessageBroadcast(bytes(json.dumps(data),'utf-8'), 'ledbox')
                self.stop()
            val = value['value']
            path = app.API.CreateFolderAlias(value['alias'], value['sport']) + '/playlistimage'
            if os.path.isdir(path) == False:
                os.mkdir(path)
            path = path + '/playlist_' + val['hashname'] + '.json'
            file = open(path, 'wb')
            file.write(bytes(json.dumps(val),'utf-8'))
            file.close()
            return val

    def StartPlaylistImage(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        if 'hashname' not in value['value']:
            return ErrorMessage.getMessage(9, 'hashname')
        self.start(value)
        result = {}
        result['hashname'] = value['value']['hashname']
        result['title'] = self.current_playlisttitle
        return result

    def StopPlaylistImage(self, value):
        result = {}
        result['hashname'] = self.current_playlistname
        result['title'] = self.current_playlisttitle
        self.stop()
        return result

    def PausePlaylistImage(self, value):
        if 'hashname' not in value['value']:
            return ErrorMessage.getMessage(9, 'hashname')
        result = {}
        result['hashname'] = value['value']['hashname']
        result['title'] = self.current_playlisttitle
        self.pause()
        return result

    def GetListPlaylistImage(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        else:
            if 'sport' not in value:
                return ErrorMessage.getMessage(9, 'sport')
            listPlaylist = []
            path_media = 'media/' + value['alias'] + '/' + value['sport'] + '/playlistimage'
            if os.path.isdir(path_media) == False:
                return listPlaylist
            for f in os.listdir(path_media):
                filename, extension = os.path.splitext(f)
                if extension == '.json':
                    filetype, name = filename.split('_')
                    if filetype == 'playlist':
                        file_stats=os.stat(path_media + '/' + f)
                        if(file_stats.st_size>0):
                            filejson = open(path_media + '/' + f, 'r')
                            playlist = json.loads(filejson.read())
                            filejson.close()
                            if 'Title' in playlist:
                                title = playlist['Title']
                            if 'title' in playlist:
                                title = playlist['title']
                            data = {}
                            data['title'] = title
                            data['hashname'] = playlist['hashname']
                            if self._current_playlist != None and name == self._current_playlist.playlistname:
                                data['current_status'] = self.current_status
                            else:
                                data['current_status'] = 0
                            data['type'] = 0
                            listPlaylist.append(data)

            return listPlaylist

    def DeleteAllPlaylistImage(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        path_media = 'media/' + value['alias'] + '/' + value['sport'] + '/playlistimage/'
        shutil.rmtree(path_media)
        return True

    def UploadPlaylistImage(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        path = app.API.CreateFolderAlias(value['alias'], value['sport'])
        path = path + '/playlistimage'
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
        playlistname = value['value']['hashname']
        if self._current_playlist != None and self._current_playlist.getPauseStatus() == True:
            if self._current_playlist.playlistname == playlistname:
                self._current_playlist.resume()
                app.Debug('RESUME PLAYLIST')
            else:
                self.stop()
                data = {}
                data['status'] = 'ok'
                data['sender'] = 'StopPlaylistImage'
                result = {}
                result['hashname'] = self.current_playlistname
                result['title'] = self.current_playlisttitle
                data['value'] = result
                app.sendToClients(json.dumps(data))
                self.start(playlistname)
        else:
            layout_tmp = app.current_layout.name
            self.stop()
            path = 'media/' + value['alias'] + '/' + value['sport'] + '/playlistimage/'
            filepath = path + 'playlist_' + playlistname + '.json'
            if os.path.isfile(filepath):
                filejson = open(filepath, 'r')
                playlist = json.loads(filejson.read())
                filejson.close()
                app.current_layout = app.layoutManager.loadLayout('image')
                self._current_playlist = ThreadPlaylist(playlistname, playlist['title'], layout_tmp, path, self._clientid)
                self.current_playlistname = playlist['hashname']
                self.current_playlisttitle = playlist['title']
                self._thread_playlist = threading.Thread(target=self._current_playlist.run, args=())
                self._thread_playlist.start()
        self.current_status = self._STATUS_PLAY
        return

    def stop(self):
        if self._current_playlist != None and self._current_playlist != '':
            self._current_playlist.stop()
            if self._current_playlist.returnLayout == None:
                self._current_playlist.returnLayout = 'waiting'
            app.current_layout = app.layoutManager.loadLayout(self._current_playlist.returnLayout)
        self._current_playlist = None
        self.current_playlistname = ''
        self.current_status = self._STATUS_STOP
        return

    def pause(self):
        if self._current_playlist != None:
            self._current_playlist.pause()
            self.current_status = self._STATUS_PAUSE
        return


class ThreadPlaylist(threading.Thread):
    _pause = False
    playlistname = ''
    playlisttitle = ''
    path = ''
    clientid = None

    def __init__(self, playlistname, playlisttitle, returnLayout, path, clientid):
        threading.Thread.__init__(self)
        self._stop_event = threading.Event()
        self.playlistname = playlistname
        self.playlisttitle = playlisttitle
        self.returnLayout = returnLayout
        self.path = path
        self.clientid = clientid

    def getPauseStatus(self):
        return self._pause

    def stop(self):
        self._stop_event.set()

    def stopped(self):
        return self._stop_event.is_set()

    def resume(self):
        self._pause = False

    def pause(self):
        self._pause = True

    def run(self):
        filepath = self.path + 'playlist_' + self.playlistname + '.json'
        if os.path.isfile(filepath):
            filejson = open(filepath, 'r')
            playlist = json.loads(filejson.read())
            onfinish = ''
            max_counter_time = 0
            items = []
            playlist_title = ''
            if 'Title' in playlist:
                playlist_title = playlist['Title']
            if 'title' in playlist:
                playlist_title = playlist['title']
            if 'Counter_Duration' in playlist:
                max_counter_time = playlist['Counter_Duration']
            if 'max_counter_time' in playlist:
                max_counter_time = playlist['max_counter_time']
            if 'openlastlayout' in playlist:
                onfinish = playlist['openlastlayout']
            if 'onfinish' in playlist:
                onfinish = playlist['onfinish']
                if onfinish == None:
                    onfinish = 'waiting'
            if 'Items' in playlist:
                items = playlist['Items']
            if 'items' in playlist:
                items = playlist['items']
            filejson.close()
            app.current_playlist = self.playlistname
            if onfinish != '':
                self.returnLayout = onfinish
            i = 0
            counter_time = 0
            remaing_time = max_counter_time + 1
            file = items[0]
            app.current_layout.setSection('counter', 'text', '')
            if max_counter_time > 0:
                app.current_layout.setSection('bg', 'visible', True)
            else:
                app.current_layout.setSection('bg', 'visible', False)
            while not self.stopped():
                if self._pause == True:
                    continue
                if counter_time >= file['duration']:
                    i = i + 1
                    counter_time = 0
                    if i >= len(items):
                        i = 0
                if max_counter_time > 0:
                    remaing_time = remaing_time - 1
                    app.current_layout.setSection('counter', 'text', time.strftime('%M:%S', time.gmtime(remaing_time)))
                    if remaing_time == 0:
                        data = {}
                        data['status'] = 'ok'
                        data['sender'] = 'StopPlaylistImage'
                        result = {}
                        result['hashname'] = self.playlistname
                        result['title'] = playlist_title
                        data['value'] = result
                        app.sendToClients(json.dumps(data))
                        self.stop()
                        if self.returnLayout == '':
                            self.returnLayout = 'waiting'
                        app.current_layout = app.layoutManager.loadLayout(self.returnLayout)
                        return
                file = items[i]
                file_path = self.path + file['filename']
                if self.stopped() or self._pause == True:
                    continue
                file_path = self.path + file['filename']
                try:
                    if os.path.isfile(file_path):
                        if file['type'] == 0:
                            app.current_layout.setSection('media', 'typesection', 'image')
                            app.current_layout.setSection('media', 'src', file_path)
                        if file['type'] == 1:
                            app.current_layout.setSection('media', 'typesection', 'video')
                            app.current_layout.setSection('media', 'src', file_path)
                    time.sleep(1)
                    counter_time = counter_time + 1
                except:
                    print ('error playlist ' + file['filename'])

        return