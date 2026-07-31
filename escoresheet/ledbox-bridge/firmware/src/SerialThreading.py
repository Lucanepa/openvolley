# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/SerialThreading.py
# Compiled at: 2021-02-18 19:32:37
import threading, io, time, serial, ledboxApp as app, gzip, ledboxFileUploadServer

class SerialThreading(threading.Thread):

    def __init__(self, serialPort, name):
        threading.Thread.__init__(self)
        self.name = name
        self.serialPort = serialPort
        self.serialUpload = ledboxFileUploadServer.socketFileUploadServer('usb')
        self.serialUpload.enable = False
        self.serialUpload.setSerialUSB(serialPort)
        self.eol = b'\r\n'
        return

    def send(self, data):
        self.serialPort.write(data)
        return

    def sendToClient(self, message, client='', compress=True):
        if isinstance(message, str):
            message = message.encode('utf-8')
        if compress:
            out = io.BytesIO()
            with gzip.GzipFile(fileobj=out, mode='wb') as gz:
                gz.write(message)
                gz.close()
            message = out.getvalue()
        try:
            self.serialPort.write(message)
            self.serialPort.write(self.eol)
            time.sleep(0.2)
        except Exception as e:
            print('ERROR Send serial message ' + str(e))
            if client.address == 'USB2':
                self.serialPort.close()
                time.sleep(2)
                self.serialPort.open()

        return

    def sendPreview(self):
        time.sleep(0.01)
        self.serialPort.write(open('www/buffer_compressed.png', 'rb').read())
        self.serialPort.write(b'\n<<EOF>>\n')
        return

    def run(self):
        print('Serial Port ' + self.serialPort.port + ' opened\n')
        data = ''
        leneol = len(self.eol)
        data = bytearray()
        client = app.addClient(self, self.serialPort, self.name)
        if client.address == 'USB2':
            app.editClient(client.id, '', '', '', 'ledbox', '')
        while True:
            try:
                if self.serialPort.isOpen():
                    c = self.serialPort.read(1)
                    if c:
                        data += c
                        if data[-leneol:] == self.eol:
                            response = app.processMessage(bytes(data[:-leneol]), client, True)
                            if response != None:
                                self.sendToClient(response)
                                if 'Upload' in response and ('"exist": false' in response or '"exist": true' in response and '"forceUpload": true' in response):
                                    print('Start UPLOAD')
                                    self.serialUpload.enable = True
                                    self.serialUpload.run()
                                    print('Close UPLOAD')
                            self.sendPreview()
                            data = bytearray()
                    elif len(data) > 0:
                        response = app.processMessage(bytes(data), client, True)
                        if response != None:
                            self.sendToClient(response)
                            if 'Upload' in response and ('"exist": false' in response or '"exist": true' in response and '"forceUpload": true' in response):
                                print('Start UPLOAD')
                                self.serialUpload.enable = True
                                self.serialUpload.run()
                                print('Close UPLOAD')
                        self.sendPreview()
                        data = bytearray()
            except Exception as e:
                data = bytearray()
                print('ERROR ' + str(e))
                if client.address == 'USB2':
                    self.serialPort.close()

        return


