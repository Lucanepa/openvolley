# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/LedboxPlugin.py
# Compiled at: 2021-02-18 19:32:31
import inspect, string, configparser, os

class LedboxPlugin:
    __name = ''
    __version = 0.1
    __config = None
    _clientid = ''

    def __init__(self, version):
        self.__name = self.__class__.__name__.replace('Plugin', '')
        self.__version = version
        self._setConfig()
        return

    def setClient(self, id):
        self._clientid = id
        return

    def getInfo(self):
        data = {}
        data['name'] = self.__name
        data['version'] = self.__version
        data['parameters'] = []
        for attribute, value in list(self.__dict__.items()):
            if attribute[:1] != '_':
                param1 = {}
                param1[attribute] = value
                data['parameters'].append(param1)

        return data

    def onAfterMessageProcess(self, message, client):
        return False

    def onBeforeMessageProcess(self, message, client):
        return False

    def getConfig(self):
        return self.__config

    def _setConfig(self):
        if os.path.exists('plugin/' + self.__name + '.ini'):
            self.__config = configparser.ConfigParser()
            self.__config.read('plugin/' + self.__name + '.ini')
        return


