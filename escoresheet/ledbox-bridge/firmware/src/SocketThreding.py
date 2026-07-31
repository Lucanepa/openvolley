# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/SocketThreding.py
# Compiled at: 2021-02-18 19:32:38
import threading

class SocketThreding(threading.Thread):

    def __init__(self, server_sock):
        threading.Thread.__init__(self)
        self.server_sock = server_sock
        return

    def run(self):
        print('Socket ' + self.server_sock.name + ' ' + self.server_sock.mode + ' opened')
        if self.server_sock.mode == 'master':
            self.server_sock.open()
        else:
            self.server_sock.client_connect()
        return


