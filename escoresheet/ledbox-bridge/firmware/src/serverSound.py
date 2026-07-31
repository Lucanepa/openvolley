# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: serverSound.py
# Compiled at: 2021-02-18 19:32:37
import pygame as pg, socket, json, sys
mp3 = ''
volume = 0.8
current_filename = ''
freq = 44100
bitsize = -16
channels = 2
buffer = 2048
pg.mixer.init(freq, bitsize, channels, buffer)

def play_music(music_file, volume=0.8):
    pg.mixer.music.set_volume(volume)
    clock = pg.time.Clock()
    try:
        pg.mixer.music.load(music_file)
    except pg.error:
        print(('File {} not found! ({})').format(music_file, pg.get_error()))
        return

    return pg.mixer.music


def processMessage(message):
    global current_filename
    global mp3
    global volume
    data = {}
    try:
        obj_msg = json.loads(message)
        if 'cmd' in obj_msg:
            cmd = obj_msg['cmd']
        else:
            data['status'] = 'error'
            data['sender'] = ''
            data['error_code'] = 1
            data['error_message'] = 'no cmd'
            json_data = json.dumps(data)
            return json_data
        if cmd == 'play':
            current_filename = obj_msg['value']
            mp3 = play_music(obj_msg['value'], volume)
            if mp3:
                mp3.play()
        if cmd == 'stop':
            if mp3 != '':
                mp3.stop()
        if cmd == 'pause':
            if mp3 != '':
                mp3.pause()
        if cmd == 'resume':
            if mp3 != '':
                mp3.unpause()
        if cmd == 'volume':
            if mp3 != '':
                volume = obj_msg['value']
                mp3.set_volume(volume)
        if cmd == 'beep':
            beep = pg.mixer.Sound('media/buzzer.wav')
            beep.set_volume(1.0)
            beep.play()
        data['status'] = 'ok'
        data['sender'] = cmd
        data_value = {}
        data_value['file'] = current_filename
        data_value['volume'] = volume
        data['status'] = data_value
        json_data = json.dumps(data)
        print(json_data)
        return json_data
    except:
        data['status'] = 'error'
        data['sender'] = ''
        data['error_code'] = 2
        data['error_message'] = 'no json format'
        json_data = json.dumps(data)
        return json_data

    return


sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
port = 9999
sock.bind(('0.0.0.0', port))
sock.listen(5)
while True:
    client, address = sock.accept()
    print('connected')
    try:
        while True:
            data = client.recv(1024)
            if len(data) > 0:
                print(data)
                response = processMessage(data)
                client.send(response.encode('utf-8') if isinstance(response, str) else response)

    except Exception as e:
        print('Error listener ' + str(e))

