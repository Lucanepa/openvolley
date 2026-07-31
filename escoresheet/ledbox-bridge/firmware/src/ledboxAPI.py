# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/ledboxAPI.py
# Compiled at: 2021-02-18 19:32:26
import json, os, ledboxApp as app, time, subprocess, ErrorMessage, testProcedure, threading, shutil, layoutManager

class ledboxAPI:
    _clientid = ''
    _sections_config = [
     'GENERAL', 'WIFI', 'LAYOUT', 'NETWORK']
    _exclude_config = [5, 6, 7, 8, 9]

    def setClient(self, id):
        self._clientid = id
        return

    def Info(self, data):
        result = {}
        result['deviceName'] = app.deviceName
        result['version'] = app.version
        return result

    def Init(self, data):
        if 'version' not in data['value']:
            return ErrorMessage.getMessage(9, 'version')
        else:
            if 'alias' not in data:
                return ErrorMessage.getMessage(9, 'alias')
            else:
                if 'sport' not in data:
                    return ErrorMessage.getMessage(9, 'sport')
                if float(data['value']['version']) < app.MINUMUN_VERSION_APP:
                    return ErrorMessage.getMessage(8)
                app.alias = data['alias']
                self.CreateFolderAlias(data['alias'], data['sport'])
                result = {}
                result['deviceName'] = app.deviceName
                result['version'] = app.version
                if 'typedevice' in data['value']:
                    typedevice = data['value']['typedevice']
                else:
                    typedevice = 'app'
                result['role'] = app.getRoleFromClients(self._clientid)
                if typedevice == 'ledbox':
                    result['role'] = 'guest'
                result['current_layout'] = app.current_layout.name
                result['plugins'] = []
                for plugin in app.plugin:
                    result['plugins'].append(plugin.getInfo())

                config = None
                if 'config' in result:
                    config = result['config']
                app.editClient(self._clientid, data['alias'], data['sport'], result['role'], typedevice, config)
                result['noresend'] = True
                return result

            return

    def GetListAlias(self, data):
        path_media = 'media/'
        listAlias = []
        for f in os.listdir(path_media):
            if os.path.isdir(path_media + f):
                data = {}
                data['alias'] = f
                listAlias.append(data)

        return listAlias

    def Connect(self, data):
        return True

    def SetLayout(self, data):
        result = ''
        result_sections = ''
        if isinstance(data['value'], list):
            result = app.layoutManager.loadLayout(data['name'])
            if isinstance(result, ErrorMessage.ErrorMessageStruct):
                return result
            app.current_layout = result
            result_sections = self.SetSections(data)
            if isinstance(result_sections, ErrorMessage.ErrorMessageStruct):
                return result_sections
        else:
            result = app.layoutManager.loadLayout(data['value'])
            if isinstance(result, ErrorMessage.ErrorMessageStruct):
                return result
            app.current_layout = result
        return app.current_layout.name

    def ReloadLayout(self, data):
        result = ''
        result = app.layoutManager.loadLayout(data['value'], True)
        if isinstance(result, ErrorMessage.ErrorMessageStruct):
            return result
        app.current_layout = result
        return app.current_layout.name

    def GetLayout(self, data):
        return app.current_layout.name

    def SetSection(self, data):
        if 'name' not in data:
            return ErrorMessage.getMessage(9, 'name')
        if 'value' not in data:
            return ErrorMessage.getMessage(9, "'value' in section " + data['name'])
        if isinstance(data['value'], list):
            result = True
            for v in data['value']:
                if 'attrib' not in v:
                    return ErrorMessage.getMessage(9, "'attrib' in section " + data['name'])
                if 'value' not in v:
                    return ErrorMessage.getMessage(9, "'value' in section " + data['name'])
                result = app.current_layout.setSection(data['name'], v['attrib'], v['value'])
                if isinstance(result, ErrorMessage.ErrorMessageStruct):
                    return result

            return result
        if 'attrib' not in data['value']:
            return ErrorMessage.getMessage(9, "'attrib' in section " + data['name'])
        if 'value' not in data['value']:
            return ErrorMessage.getMessage(9, "'value' in section " + data['name'])
        result = app.current_layout.setSection(data['name'], data['value']['attrib'], data['value']['value'])
        return result

    def SetSections(self, data):
        for v in data['value']:
            result = self.SetSection(v)
            if isinstance(result, ErrorMessage.ErrorMessageStruct):
                return result

        return result

    def GetSection(self, data):
        if 'name' not in data:
            return ErrorMessage.getMessage(9, 'name')
        result = app.current_layout.getSection(data['name'])
        return result

    def GetSections(self, data):
        result = app.current_layout.getSections()
        return result

    def Horn(self, data):
        value = data['value']
        if 'times' not in value:
            return ErrorMessage.getMessage(9, 'times')
        if 'sleep' not in value:
            return ErrorMessage.getMessage(9, 'sleep')
        for i in range(0, value['times']):
            app.play_beep()
            threading.Thread(target=app.play_buzzer(value['sleep']), args=()).start()
            time.sleep(value['sleep'])

        return True

    def GetConfig(self, data):
        value = data['value']
        if 'section' not in value:
            return ErrorMessage.getMessage(9, 'section')
        if 'field' not in value:
            return ErrorMessage.getMessage(9, 'field')
        result = {}
        result['value'] = app.UserConfig.get(value['section'], value['field'])
        result['section'] = value['section']
        result['field'] = value['field']
        result['device'] = app.deviceName
        return result

    def GetConfigs(self, data):
        app.getNetworkInfo()
        result = []
        for section_name in app.UserConfig.sections():
            for name, value in app.UserConfig.items(section_name):
                if section_name in self._sections_config:
                    if name not in self._exclude_config:
                        item = {}
                        item['value'] = value
                        item['section'] = section_name
                        item['field'] = name
                        item['device'] = app.deviceName
                        result.append(item)

        item = {}
        item['value'] = app.current_eth_ip
        item['section'] = 'NETWORK'
        item['field'] = 'current_lan_ip'
        item['device'] = app.deviceName
        result.append(item)
        item = {}
        item['value'] = app.current_wifi_ip
        item['section'] = 'NETWORK'
        item['field'] = 'current_wifi_ip'
        item['device'] = app.deviceName
        result.append(item)
        return result

    def SetConfig(self, data):
        if 'section' not in data:
            return ErrorMessage.getMessage(9, 'section')
        if 'field' not in data:
            return ErrorMessage.getMessage(9, 'field')
        if 'value' not in data:
            return ErrorMessage.getMessage(9, 'value')
        if 'device' not in data:
            return ErrorMessage.getMessage(9, 'device')
        if data['device'] == app.deviceName:
            app.UserConfig.set(data['section'], data['field'], data['value'])
        app.saveConfig()
        return True

    def SetConfigs(self, data):
        value = data['value']
        for item in value:
            if 'section' not in item:
                return ErrorMessage.getMessage(9, 'section')
            if 'field' not in item:
                return ErrorMessage.getMessage(9, 'field')
            if 'value' not in item:
                return ErrorMessage.getMessage(9, 'value')
            if 'device' not in item:
                return ErrorMessage.getMessage(9, 'device')
            if item['device'] == app.deviceName:
                if item['section'] != None:
                    if item['section'] == 'LAYOUT' and item['field'] == 'modifier':
                        app.modifier = item['value']
                    app.UserConfig.set(item['section'], item['field'], item['value'])

        app.saveConfig()
        return True

    def Upload(self, data):
        value = data['value']
        requestToUpload = value
        if 'type' not in value:
            return ErrorMessage.getMessage(9, 'type')
        if 'filename' not in value:
            return ErrorMessage.getMessage(9, 'filename')
        if 'alias' not in data:
            return ErrorMessage.getMessage(9, 'alias')
        if 'sport' not in data:
            return ErrorMessage.getMessage(9, 'sport')
        typeToUpload = value['type']
        path = value['type']
        if typeToUpload == 'media':
            path = self.CreateFolderAlias(data['alias'], data['sport'])
        if typeToUpload == 'layout':
            path = 'layout'
        if typeToUpload == 'plugin':
            path = 'plugin'
        if typeToUpload == 'interface':
            path = 'www/remote'
        if path == '':
            filepathToUpload = value['filename']
        else:
            filepathToUpload = path + '/' + value['filename']
        app.setUploadClient(self._clientid, filepathToUpload, typeToUpload, requestToUpload)
        exist = False
        if os.path.exists(os.path.abspath(filepathToUpload)):
            exist = True
        value['exist'] = exist
        return value

    def ChangeWaiting(self, data):
        value = data['value']
        requestToUpload = value
        typeToUpload = ''
        filepathToUpload = 'media/banner.jpg'
        app.setUploadClient(self._clientid, filepathToUpload, typeToUpload, requestToUpload)
        value['exist'] = False
        return value

    def CreateFolderAlias(self, alias, sport=''):
        try:
            path = 'media/' + alias
            if os.path.isdir(path) == False:
                os.mkdir(path)
            if sport != '':
                path = 'media/' + alias + '/' + sport
                if os.path.isdir(path) == False:
                    os.mkdir(path)
            return path
        except OSError:
            print('Error to create directory ' + path)
            return False

        return

    def createSection(self, name, attrib, value):
        data = {}
        data['name'] = name
        data_value = {}
        data_value['value'] = str(value)
        data_value['attrib'] = attrib
        data['value'] = data_value
        return data

    def Reboot(self, data):
        os.system('sudo shutdown -r now')
        return True

    def RestartDHCP(self, data):
        os.system('bin/dhcp')
        return True

    def showInfo(self, data=''):
        app.getNetworkInfo()
        time.sleep(0.5)
        result = {}
        result['name'] = 'intro'
        result['value'] = []
        result['value'].append(self.createSection('device', 'text', app.deviceName))
        result['value'].append(self.createSection('wifissid', 'text', app.UserConfig.get('WIFI', 'ssid_ap')))
        result['value'].append(self.createSection('wifipass', 'text', app.UserConfig.get('WIFI', 'psk_ap')))
        result['value'].append(self.createSection('wifiip', 'text', app.current_wifi_ip))
        result['value'].append(self.createSection('ethip', 'text', app.current_eth_ip))
        result['value'].append(self.createSection('version', 'text', 'Versione ' + str(app.version)))
        result['value'].append(self.createSection('timer', 'text', '8'))
        self.SetLayout(result)
        for i in range(1, 8):
            self.SetSection(self.createSection('timer', 'text', str(8 - i)))
            time.sleep(1)

        v = {}
        v['value'] = 'waiting'
        self.SetLayout(v)
        return True

    def StopAllProcess(self, data):
        for plugin in app.plugin:
            cmd = getattr(plugin, 'stop', None)
            if cmd != None:
                cmd()

        app.current_layout = app.layoutManager.loadLayout('waiting')
        return True

    def GetListMedia(self, data):
        listMedia = []
        for plugin in app.plugin:
            cmd = getattr(plugin, 'getList', None)
            if cmd != None:
                result = {}
                result.name = plugin.name
                result.value = cmd()
                listMedia.append(result)

        return listMedia

    def DeleteMediaAlias(self, data):
        if 'name' not in data:
            return ErrorMessage.getMessage(9, 'name')
        alias = data['name']
        path_media = 'media/' + alias
        shutil.rmtree(path_media)
        return True

    def DeleteInterfaces(self, data):
        v = {}
        v['value'] = 'waiting'
        self.SetLayout(v)
        path_remote = 'www/remote'
        for f in os.listdir(path_remote):
            if os.path.isfile(path_remote + '/' + f):
                filename, extension = f.split('.')
                if extension == 'zip':
                    os.remove(path_remote + '/' + f)
            if os.path.isdir(path_remote + '/' + f):
                if f != 'test':
                    shutil.rmtree(path_remote + '/' + f)

        path_layout = 'layout'
        for f in os.listdir(path_layout):
            if os.path.isfile(path_layout + '/' + f):
                os.remove(path_layout + '/' + f)

        layoutManager.layouts = []
        layoutManager.loadSystemLayout()
        return True

    def GetClients(self, data):
        results = []
        for client in app.clients:
            result = {}
            result['id'] = client.id
            result['socket'] = client.socket.name
            result['alias'] = client.alias
            result['sport'] = client.sport
            result['type'] = client.typedevice
            result['config'] = client.config
            results.append(result)

        return results

    def Test(self, data):
        testProcedure.run()
        return True

    def CheckTest(self, data):
        testProcedure.checkUSBSendend(data['value'])
        return True

    def Ack(self, data):
        return

    def Disconnect(self, data):
        app.removeClientById(clientid=self._clientid)
        result = {}
        result['noresend'] = True
        return result


