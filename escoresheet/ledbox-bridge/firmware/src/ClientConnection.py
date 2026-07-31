# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/ClientConnection.py
# Compiled at: 2021-02-18 19:32:22
import ledboxApp as app, socket

class ClientConnection:
    id = ''
    client = None
    clienttype = ''
    address = ''
    alias = ''
    sport = ''
    socket = None
    role = ''
    typedevice = 'app'
    filepathToUpload = ''
    typeToUpload = ''
    requestToUpload = ''
    sock_upload = ''
    config = ''

    def connectToUploadServer(self):
        if self.address == 'USB2':
            self.sock_upload = self.socket
        else:
            self.sock_upload = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.sock_upload.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.sock_upload.connect((self.address, 12345))
        return

    def sendToUploadServer(self, data):
        print('Data send to ' + self.address)
        self.sock_upload.send(data)
        return

    def closeUploadServer(self):
        if self.address != 'USB2':
            self.sock_upload.close()
        return


