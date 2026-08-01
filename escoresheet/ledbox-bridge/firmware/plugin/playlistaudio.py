# uncompyle6 version 3.7.4
# Python bytecode 2.7 (62211)
# Decompiled from: Python 2.7.16 (default, Oct 10 2019, 22:02:15) 
# [GCC 8.3.0]
# Embedded file name: playlistaudio.py
# Compiled at: 2021-02-18 07:58:54
import threading, ledboxApp as app, json, time, os
from LedboxPlugin import LedboxPlugin
import shutil

class playlistaudioPlugin(LedboxPlugin):
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

    def SetPlaylistAudio(self, value):
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
                data['sender'] = 'StopPlaylistAudio'
                result = {}
                result['hashname'] = self._current_playlist.playlistname
                result['title'] = self._current_playlist.playlisttitle
                data['value'] = result
                app.resendMessageBroadcast(json.dumps(data), 'ledbox')
                self.stop()
            val = value['value']
            path = app.API.CreateFolderAlias(value['alias'], value['sport']) + '/playlistaudio'
            if os.path.isdir(path) == False:
                os.mkdir(path)
            path = path + '/playlist_' + val['hashname'] + '.json'
            file = open(path, 'wb')
            file.write(bytes(json.dumps(val),'utf-8'))
            file.close()
            return val

    def StartPlaylistAudio(self, value):
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

    def StopPlaylistAudio(self, value):
        result = {}
        result['hashname'] = self.current_playlistname
        result['title'] = self.current_playlisttitle
        self.stop()
        return result

    def PausePlaylistAudio(self, value):
        if 'hashname' not in value['value']:
            return ErrorMessage.getMessage(9, 'hashname')
        result = {}
        result['hashname'] = value['value']['hashname']
        result['title'] = self.current_playlisttitle
        self.pause()
        return result

    def GetListPlaylistAudio(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        else:
            if 'sport' not in value:
                return ErrorMessage.getMessage(9, 'sport')
            listPlaylist = []
            path_media = 'media/' + value['alias'] + '/' + value['sport'] + '/playlistaudio'
            if os.path.isdir(path_media) == False:
                return listPlaylist
            for f in os.listdir(path_media):
                filename, extension = os.path.splitext(f)
                if extension == '.json':
                    filetype, name = filename.split('_')
                    if filetype == 'playlist':
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
                        data['type'] = 2
                        listPlaylist.append(data)

            return listPlaylist

    def DeleteAllPlaylistAudio(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        alias = value['name']
        path_media = 'media/' + alias + '/' + value['sport'] + '/playlistaudio/'
        shutil.rmtree(path_media)
        return True

    def UploadPlaylistAudio(self, value):
        if 'alias' not in value:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in value:
            return ErrorMessage.getMessage(9, 'sport')
        path = app.API.CreateFolderAlias(value['alias'], value['sport'])
        path = path + '/playlistaudio'
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
        if self._current_playlist != None:
            if self._current_playlist.playlistname == playlistname:
                self._current_playlist.resume()
                app.Debug('RESUME PLAYLIST')
            else:
                self.stop()
                data = {}
                data['status'] = 'ok'
                data['sender'] = 'StopPlaylistAudio'
                result = {}
                result['hashname'] = self.current_playlistname
                result['title'] = self.current_playlisttitle
                data['value'] = result
                app.sendToClients(json.dumps(data))
                self.start(playlistname)
        else:
            self.stop()
            path = 'media/' + value['alias'] + '/' + value['sport'] + '/playlistaudio/'
            filepath = path + 'playlist_' + playlistname + '.json'
            if os.path.isfile(filepath):
                filejson = open(filepath, 'r')
                playlist = json.loads(filejson.read())
                filejson.close()
                self._current_playlist = ThreadPlaylist(playlistname, playlist['title'], path)
                self.current_playlistname = playlist['hashname']
                self.current_playlisttitle = playlist['title']
                self._thread_playlist = threading.Thread(target=self._current_playlist.run, args=())
                self._thread_playlist.start()
        self.current_status = self._STATUS_PLAY
        return

    def stop(self):
        if self._current_playlist != None and self._current_playlist != '':
            self._current_playlist.stop()
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

    def __init__(self, playlistname, playlisttitle, path):
        threading.Thread.__init__(self)
        self._stop_event = threading.Event()
        self.playlistname = playlistname
        self.playlisttitle = playlisttitle
        self.path = path

    def stop(self):
        app.stop_playmusic()
        self._stop_event.set()

    def stopped(self):
        return self._stop_event.is_set()

    def resume(self):
        app.resume_playmusic()
        self._pause = False

    def pause(self):
        app.pause_playmusic()
        self._pause = True

    def run(self):
        filepath = self.path + 'playlist_' + self.playlistname + '.json'
        if os.path.isfile(filepath):
            filejson = open(filepath, 'r')
            playlist = json.loads(filejson.read())
            filejson.close()
            app.current_playlist = self.playlistname
            items = []
            playlist_title = ''
            if 'Items' in playlist:
                items = playlist['Items']
            if 'items' in playlist:
                items = playlist['items']
            i = 0
            file = items[0]
            while not self.stopped():
                if self._pause == True:
                    continue
                file = items[i]
                file_path = self.path + '/' + file['filename']
                if self.stopped() or self._pause == True:
                    continue
                file_path = self.path + file['filename']
                try:
                    if os.path.isfile(file_path):
                        if file['type'] == 2:
                            mp3 = app.start_playmusic(file_path, 0.8)
                    time.sleep(file['duration'])
                    if i < len(items) - 1:
                        i = i + 1
                    else:
                        i = 0
                except:
                    print ('error playlist ' + file['filename'])
                    app.stop_playmusic()