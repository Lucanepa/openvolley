# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/ledboxFileUploadServer.py
# Compiled at: 2021-02-18 19:32:30
import socket, bluetooth, json, threading, ledboxApp as app, os
from PIL import Image
import zipfile, subprocess
from threading import Timer

class socketFileUploadServer(threading.Thread):
    enable = True

    def __init__(self, type):
        threading.Thread.__init__(self)
        self.type = type
        self.serial = ''
        self.receiveSerialData = False
        self.onProgress = True
        return

    def is_json(self, myjson):
        try:
            json_object = json.loads(myjson)
        except:
            return False

        return True

    def getSocketBluetooth(self):
        s = bluetooth.BluetoothSocket(bluetooth.RFCOMM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        port = 12345
        s.bind(('', bluetooth.PORT_ANY))
        s.listen(1)
        uuid = '00001101-0000-1000-8000-00805F9B34FC'
        bluetooth.advertise_service(s, 'LEDBoxUpload', uuid)
        print('Socket Bluetooth Upload Server ' + str(port))
        return s

    def getSocketTCPIP(self):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            host = socket.gethostname()
            port = 12345
            s.bind(('0.0.0.0', port))
            s.listen(5)
            print('Socket TCP/IP Upload Server ' + str(port))
            return s
        except:
            return

        return

    def setSerialUSB(self, serial):
        self.serial = serial
        return

    def afterUploadInterface(self, client):
        filename, extension = os.path.splitext(client.requestToUpload['filename'])
        path = 'www/remote/' + filename
        if os.path.isdir(path) == False:
            os.mkdir(path)
        try:
            with zipfile.ZipFile(client.filepathToUpload, 'r') as zip_ref:
                zip_ref.extractall(path)
        except:
            return False

        path_layouts = path + '/layouts'
        if os.path.isdir(path_layouts):
            for f in os.listdir(path_layouts):
                path_file = path_layouts + '/' + f
                if os.path.isfile(path_file):
                    try:
                        filename, extension = os.path.splitext(f)
                        if extension == '.xml':
                            status = subprocess.call('cp ' + os.path.abspath(path_file) + ' ' + os.path.abspath('layout/'), shell=True)
                    except:
                        return False

        path_plugins = path + '/plugins'
        if os.path.isdir(path_plugins):
            for f in os.listdir(path_plugins):
                path_file = path_plugins + '/' + f
                if os.path.isfile(path_file):
                    try:
                        filename, extension = os.path.splitext(f)
                        status = subprocess.call('cp ' + os.path.abspath(path_file) + ' ' + os.path.abspath('plugin/'), shell=True)
                    except:
                        return False

        app.loadPlugin()
        return True

    def afterUpload(self, client):
        if os.path.isfile(client.filepathToUpload) == False:
            return
        filename, extension = os.path.splitext(client.filepathToUpload)
        if extension == '.zip':
            try:
                with zipfile.ZipFile(client.filepathToUpload, 'r') as zip_ref:
                    zip_ref.extractall(os.path.dirname(client.filepathToUpload))
            except:
                os.remove(client.filepathToUpload)
                print('ERROR after upload ' + client.filepathToUpload)
                return False

        return True

    def timeoutSerial(self):
        if self.receiveSerialData == False:
            self.onProgress = False
        return

    def run(self):
        buffersize = 1024
        connection_name = 'TCP/IP'
        if self.type == 'tcpip':
            s = self.getSocketTCPIP()
            buffersize = 1024
            connection_name = 'TCP/IP'
        if self.type == 'bluetooth':
            s = self.getSocketBluetooth()
            buffersize = 1024
            connection_name = 'Bluetooth'
        if self.type == 'usb':
            connection_name = 'USB'
        if s == None:
            app.Debug('ERROR: Upload Server ' + self.name + ' not run')
            print('Socket ' + self.name + ' not run')
            return
        else:
            fileopen = False
            data = b''
            self.onProgress = True
            while self.onProgress:
                if connection_name == 'USB':
                    print('Connection USB')
                    try:
                        startReceiving = True
                        app.Debug('START RECEIVING FILE')
                        for cc in app.clients:
                            if cc.typedevice == 'ledbox':
                                cc.connectToUploadServer()

                        while startReceiving:
                            d = self.serial.read(1)
                            if len(d) > 0:
                                self.receiveSerialData = True
                                data += d
                                for cc in app.clients:
                                    if cc.typedevice == 'ledbox':
                                        cc.sendToUploadServer(d)

                                print('receiving')
                            else:
                                print('No value')
                                if len(data) > 0:
                                    client = app.getClient(address='USB', connection_name=connection_name)
                                    path_dir = os.path.dirname(client.filepathToUpload)
                                    if os.path.isdir(path_dir) == False:
                                        os.makedirs(path_dir)
                                    file = open(client.filepathToUpload, 'wb')
                                    file.write(data)
                                    file.close()
                                    app.Debug('RECEIVING FILE: ' + client.filepathToUpload + ' finish')
                                    startReceiving = False
                                    self.onProgress = False

                    except Exception as e:
                        app.Debug('ERROR USB UPLOADER :' + str(e))

                else:
                    c, addr = s.accept()
                    client = app.getClient(address=addr[0], connection_name=connection_name)
                    try:
                        path_dir = os.path.dirname(client.filepathToUpload)
                        if path_dir != '':
                            if os.path.isdir(path_dir) == False:
                                os.makedirs(path_dir)
                        l = c.recv(buffersize)
                        if l:
                            app.Debug('RECEIVING FILE: ' + client.filepathToUpload)
                            file = open(client.filepathToUpload, 'wb')
                            fileopen = True
                            for cc in app.clients:
                                if cc.typedevice == 'ledbox':
                                    cc.connectToUploadServer()

                        while l:
                            file.write(l)
                            for cc in app.clients:
                                if cc.typedevice == 'ledbox':
                                    cc.sendToUploadServer(l)

                            try:
                                l = c.recv(buffersize)
                            except:
                                l = None

                        app.Debug('RECEIVING FILE: ' + client.filepathToUpload + ' finish')
                        if fileopen == True:
                            file.close()
                        c.close()
                        for cc in app.clients:
                            if cc.typedevice == 'ledbox':
                                cc.closeUploadServer()

                    except Exception as e:
                        app.Debug('ERROR: Error during receiving file ' + client.filepathToUpload)
                        print('Error during receiving ' + str(e))
                        if fileopen == True:
                            file.close()
                        c.close()
                        for cc in app.clients:
                            if cc.typedevice == 'ledbox':
                                cc.closeUploadServer()

                    result = True
                    if client.typeToUpload == 'interface':
                        result = self.afterUploadInterface(client)
                    else:
                        result = self.afterUpload(client)
                    if result:
                        message = app.createMessage('Uploaded', client.requestToUpload)
                        print('Done Receiving ' + client.filepathToUpload)
                    else:
                        message = app.createErrorMessage('Uploaded', 99)
                        print('Error Receiving')
                    if client != None:
                        app.Debug('SEND to ' + str(client.id) + ' (' + client.socket.name + ') ' + client.address + '=' + message)
                        client.socket.sendToClient(message, client.client)
                    if connection_name == 'USB':
                        return

            return
            return


