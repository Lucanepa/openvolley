# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/WebSocketServerClass.py
# Compiled at: 2021-02-18 19:32:39
import ledboxApp as app
from websocket_server import WebsocketServer
import json

class WebSocketServerClass:
    server = None
    connections = []
    name = 'WebSocket'

    def __init__(self, port):
        self.server = WebsocketServer(port, host='0.0.0.0')
        self.server.set_fn_new_client(self.new_client)
        self.server.set_fn_message_received(self.onMessage)
        self.server.set_fn_client_left(self.client_left)
        return

    def run(self):
        self.server.run_forever()
        return self.server

    def new_client(self, client, server):
        data = {}
        data['status'] = 'ok'
        data['sender'] = 'Connect'
        json_data = json.dumps(data)
        self.connections.append(client)
        app.addClient(self, client)
        server.send_message(client, json_data)
        return

    def client_left(self, client, server):
        app.removeClient(self, client)
        if client != None:
            self.connections.remove(client)
        return

    def onMessage(self, client, server, message):
        c = app.getClientBySocketClient(self, client)
        response = app.processMessage(message, c)
        server.send_message(client, response)
        return

    def send(self, message):
        self.server.send_message_to_all(message)
        return

    def sendToClient(self, message, client, compress=True):
        self.server.send_message(client, message)
        return


