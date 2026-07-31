# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/socketStruct.py
# Compiled at: 2021-02-18 19:32:38
import ledboxApp as app, io, gzip, threading

class socketStruct:

    def __init__(self):
        self.sock = ''
        self.enable = True
        self.port = 0
        self.mode = 'master'
        self.ip_master = '0.0.0.0'
        self.port_master = 0
        self.isconnect = False
        self.name = ''
        self.compressProtocol = False
        self.eol = '\r\n'
        return

    def sendToClient(self, message, client, compress=True):
        try:
            if isinstance(message, str):
                message = message.encode('utf-8')
            if self.compressProtocol == True and compress == True:
                out = io.BytesIO()
                with gzip.GzipFile(fileobj=out, mode='wb') as gz:
                    gz.write(message)
                    gz.close()
                    client.send(out.getvalue())
            else:
                client.send(message + b'\n')
        except:
            print('client error')
            app.removeClient(self, client)

        return

    def client_connect(self):
        toconnect = False
        while toconnect == False:
            try:
                self.sock.connect((self.ip_master, self.port_master))
                c = app.addClient(self, self.sock, self.ip_master, 'master')
                print('Socket Client connected at ' + self.ip_master)
                datavalue = {}
                datavalue['alias'] = app.deviceName
                datavalue['typedevice'] = 'ledbox'
                datavalue['version'] = app.MINUMUN_VERSION_APP
                json_data = app.createMessage('Init', datavalue, app.deviceName)
                threading.Thread(target=self.listenToClient, args=(self.sock, c, 'slave')).start()
                toconnect = True
                self.sendToClient(json_data, self.sock)
            except Exception as e:
                print('Error Client connection: ' + str(e))

        return

    def open(self):
        try:
            if self.sock != None:
                while True:
                    client, address = self.sock.accept()
                    self.isconnect = True
                    c = app.addClient(self, client, address[0])
                    app.setRoleToClient(c.id, app.getRoleFromClients())
                    app.debugClients()
                    threading.Thread(target=self.listenToClient, args=(client, c)).start()

            else:
                print('Socket ' + self.name + ' not run')
        except:
            print('Socket ' + self.name + ' not run')

        return

    def listenToClient(self, client, connection, mode='master'):
        leneol = len(self.eol)
        isrun = True
        while isrun:
            try:
                data = client.recv(2048)
                if len(data) > 0:
                    response = app.processMessage(bytes(data), connection, compress_message=self.compressProtocol)
                    if response != None and mode == 'master':
                        self.sendToClient(response, client)
            except Exception as e:
                print(('Error listener {m}: {c}').format(c=type(e).__name__, m=str(e)))
                if 'BluetoothError' == type(e).__name__:
                    if client != None:
                        client.close()
                        isrun = False
                        for c in app.clients:
                            if c.client == client:
                                print('Remove client')
                                app.removeClient(socket=self, client=client)

        return


