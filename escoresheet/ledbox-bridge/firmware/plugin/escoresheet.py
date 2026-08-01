# uncompyle6 version 3.7.4
# Python bytecode 2.7 (62211)
# Decompiled from: Python 2.7.16 (default, Oct 10 2019, 22:02:15) 
# [GCC 8.3.0]
# Embedded file name: plugin/escoresheet.py
# Compiled at: 2021-02-18 17:27:00
import binascii, json, ledboxApp as app, time, threading
from LedboxPlugin import LedboxPlugin
import ErrorMessage
import sys,traceback

class escoresheetPlugin(LedboxPlugin):
    _start_timeout = False
    _team1 = None
    _team2 = None
    _config = None
    _old_result = None
    _current_timeout = None
    _thread_timeout = None
    _type_protocol = ''
    _software = ''
    _count_timeout = 30
    __clientname = ''

    def __init__(self, version=0.1):
        LedboxPlugin.__init__(self, version)
        self._config = self.getConfig()

    def _debug(self, message_bytes, subdivide=32):
        p_key = ''
        p_message = ''
        k = 0
        for i in range(0, len(message_bytes)):
            p_message = p_message + str(k) + '=' + str(message_bytes[i]) + '\t'
            if k == subdivide - 1:
                k = 0
                p_message = p_message + '\n\n'
            else:
                k = k + 1

        return p_message

    def onAfterMessageProcess(self, message, client):
        
        #message_bytes=message
        try:
            message_bytes = bytearray(message)
            self.__clientname = client.socket.name
            if self._checkProtocol(message_bytes):
                end = binascii.hexlify(message_bytes[len(message_bytes) - 2:len(message_bytes)])
                if end == b'ff0a':
                    message_bytes = message_bytes[:len(message_bytes) - 2]
                subdivide = 32
                if self._type_protocol == 'ledbox':
                    subdivide = 96
                if self._type_protocol == 'litescore':
                    subdivide = 32
                messages = self._subdivideMessage(message_bytes, subdivide)
                result = None
                for m in messages:
                    app.Debug('MESSAGE SPLIT: ' + str(binascii.hexlify(m)) + '\n' + self._debug(m, subdivide))
                    result = self._processMessage(m)

                app.resendMessageBroadcast(message, app.getClientById(self._clientid), False, 'ledbox')
                return result
            else:
                return False
        except:
            return False

    def _subdivideMessage(self, messageBytes, limit):
        messages = []
        if len(messageBytes) <= limit:
            messages.append(messageBytes)
            return messages
        start = 0
        stop = limit
        while stop <= len(messageBytes) and start < stop:
            messages.append(messageBytes[start:stop])
            start = stop
            if stop + limit <= len(messageBytes):
                stop = stop + limit
            else:
                stop = len(messageBytes)

        return messages

    def _checkProtocol(self, message_bytes):
        start = binascii.hexlify(message_bytes[1:3])
        end = binascii.hexlify(message_bytes[len(message_bytes) - 2:len(message_bytes)])
        if start == b'aaaa' and (end == b'5555' or end == b'00ff' or end == b'ff0a'):
            if end == b'5555':
                self._type_protocol = 'litescore'
            if end == b'00ff' or end == b'ff0a':
                self._type_protocol = 'ledbox'
            return True
        return False

    def _parseMessageLedbox(self, message_bytes):
        Dsy_0 = bin(int(message_bytes[4]))[2]
        Dsy_1 = bin(int(message_bytes[5]))[2]
        Dsy_2 = bin(int(message_bytes[6]))[2]
        Dsy_3 = bin(int(message_bytes[7]))[2]
        Line_L = bin(int(message_bytes[8]))[2]
        Dsy_1_1 = bin(int(message_bytes[9]))[2]
        Ads_1 = bin(int(message_bytes[10]))[2]
        Ads_2 = bin(int(message_bytes[11]))[2]
        Ads_3 = bin(int(message_bytes[12]))[2]
        Ads_4 = bin(int(message_bytes[13]))[2]
        Ads_5 = bin(int(message_bytes[14]))[2]
        Ads_6 = bin(int(message_bytes[15]))[2]
        Dsy_1_2 = bin(int(message_bytes[16]))[2]
        Two_P = bin(int(message_bytes[17]))[2]
        Dsy_4 = bin(int(message_bytes[18]))[2]
        Line_R = bin(int(message_bytes[19]))[2]
        Dsy_5 = bin(int(message_bytes[20]))[2]
        Dsy_6 = bin(int(message_bytes[21]))[2]
        Dsy_7 = bin(int(message_bytes[22]))[2]
        Horn = bin(int(message_bytes[23]))[2]
        Dsy_8 = bin(int(message_bytes[28]))[2]
        Dsy_9 = bin(int(message_bytes[29]))[2]
        event = 'default'
        if int(message_bytes[83]) == 1:
            self._software = 'indoor'
        else:
            self._software = 'outdoor'
        if self._software == 'indoor':
            if int(message_bytes[84]) == 0:
                event = 'default'
            if int(message_bytes[84]) == 1:
                event = 'punto'
            if int(message_bytes[84]) == 2:
                event = 'timeout'
            if int(message_bytes[84]) == 3:
                event = 'challenge'
            if int(message_bytes[84]) == 10:
                event = 'show_serve'
            if int(message_bytes[84]) == 11:
                event = 'sub out'
            if int(message_bytes[84]) == 12:
                event = 'countdown'
        if self._software == 'outdoor':
            if int(message_bytes[84]) == 10:
                event = 'default'
            if int(message_bytes[84]) == 1:
                event = 'punto'
            if int(message_bytes[84]) == 2:
                event = 'timeout'
            if int(message_bytes[84]) == 3:
                event = 'challenge'
            if int(message_bytes[84]) == 12:
                event = 'countdown'
        '''
        if self._software == 'outdoor':
            if event == 'default' and int(Line_L) == 0 and int(Line_R) == 0:
                event = 'countdown'
        '''
        code_team1 = "" 
        for b in message_bytes[33:36] :
            if(b!=0):
                code_team1=code_team1+chr(b)
        
        name_team1=""
        #rimuovi caratteri non validi
        for b in message_bytes[39:54] :
            if(b!=0):
                name_team1=name_team1+chr(b)
        
        r, g, b = (0, 0, 0)
        
        r = int(message_bytes[54])
        g = int(message_bytes[55])
        b = int(message_bytes[56])
        

        if r == 0 and g == 0 and b == 0:
            r = 150
            g = 150
            b = 150
        color_team1 = str(r) + ',' + str(g) + ',' + str(b)
        
        code_team2 = "" 
        for b in message_bytes[58:61] :
            if(b!=0):
                code_team2=code_team2+chr(b)

        #name_team2 = str(message_bytes[64:79]).replace('\x00', '').strip()
        name_team2=""
        #rimuovi caratteri non validi
        for b in message_bytes[64:79] :
            if(b!=0):
                name_team2=name_team2+chr(b)

        
        r, g, b = (0, 0, 0)
        
       
        r = int(message_bytes[79])
        g = int(message_bytes[80])
        b = int(message_bytes[81])
        
        
        if r == 0 and g == 0 and b == 0:
            r = 150
            g = 150
            b = 150
        color_team2 = str(r) + ',' + str(g) + ',' + str(b)
        if event == 'show_serve' and message_bytes[12] == 48 and message_bytes[14] == 0:
            player = message_bytes[25]
            return {'cmd': 'show_serve', 'software': self._software, 
               'player': player, 
               'team': name_team1, 
               'color': color_team1}
        if event == 'show_serve' and message_bytes[12] == 0 and message_bytes[14] == 48:
            player = message_bytes[26]
            return {'cmd': 'show_serve', 'software': self._software, 
               'player': player, 
               'team': name_team2, 
               'color': color_team2}
        if event == 'countdown':
            countdown = str(message_bytes[26])
            return {'cmd': 'countdown', 'software': self._software, 
               'countdown': countdown}
        if event == 'timeout':
            team_countdown = 1
            t = 60
            if binascii.hexlify(message_bytes[12:13]) == b'30':
                team_countdown = 1
            if binascii.hexlify(message_bytes[14:15]) == b'30':
                team_countdown = 2
            if self._software == 'outdoor':
                t = str(message_bytes[26])
                if message_bytes[12] == 0:
                    team_countdown = 1
                else:
                    team_countdown = 2
            return {'cmd': 'timeout', 'software': self._software, 
               'time': str(t), 
               'team': team_countdown}
        if event == 'challenge':
            team_challenge = 1
            if binascii.hexlify(message_bytes[12:13]) == b'30':
                team_challenge = 1
            if binascii.hexlify(message_bytes[14:15]) == b'30':
                team_challenge = 2
            return {'cmd': 'challenge', 'software': self._software, 
               'team': team_challenge}
        if event == 'default':
            set1 = str(int(Dsy_2) + int(Dsy_3) + int(Dsy_8))
            sub1 = str(message_bytes[24])
            score1 = str(message_bytes[25])
            timeout1 = str(int(Dsy_0) + int(Dsy_1))
            challenge1 = str(message_bytes[57])
            player1 = sub1
            set2 = str(int(Dsy_4) + int(Dsy_5) + int(Dsy_9))
            score2 = str(message_bytes[26])
            sub2 = str(message_bytes[27])
            timeout2 = str(int(Dsy_6) + int(Dsy_7))
            challenge2 = str(message_bytes[82])
            player2 = sub2
            serve = '1'
            if int(Line_L) == 1:
                serve = '1'
            if int(Line_R) == 1:
                serve = '2'
            horn = False
            if int(Horn) == 1:
                horn = True
            teamname_source = self._config.get('PARAMETERS', 'teamname_source')
            teamname_source_outdoor = self._config.get('PARAMETERS', 'teamname_source_outdoor')

            if(self._software=="indoor"):
                if teamname_source == 'code':
                    teamname1 = code_team1
                    teamname2 = code_team2
                else:
                    teamname1 = name_team1
                    teamname2 = name_team2
            else:
                if teamname_source_outdoor == 'code':
                    teamname1 = code_team1
                    teamname2 = code_team2
                else:
                    teamname1 = name_team1
                    teamname2 = name_team2



            #teamname1 = str(teamname1.encode('utf8'))
            #teamname2 = str(teamname2.encode('utf8'))
            return {'software': self._software, 'team1': teamname1, 
               'team2': teamname2, 
               'color1': color_team1, 
               'color2': color_team2, 
               'score1': score1, 
               'score2': score2, 
               'sub1': sub1, 
               'sub2': sub2, 
               'player1': player1, 
               'player2': player2, 
               'timeout1': timeout1, 
               'timeout2': timeout2, 
               'set1': set1, 
               'set2': set2, 
               'challenge1': challenge1, 
               'challenge2': challenge2, 
               'serve': serve, 
               'horn': horn, 
               'cmd': 'match'}

    def _parseMessageLitescore(self, message_bytes):
        try:
            score1 = 0
            score2 = 0
            timeout1 = 0
            timeout2 = 0
            sub1 = 0
            sub2 = 0
            set1 = 0
            set2 = 0
            serve = ''
            horn = False
            if self.__clientname == 'Bluetooth':
                self._software = 'litescore_outdoor'
            else:
                self._software = 'litescore_indoor'
            start = binascii.hexlify(message_bytes[1:4])
            end = binascii.hexlify(message_bytes[30:32])
            if start == 'aaaa1c':
                return {'cmd': 'timeout', 'software': self._software}
            Dsy_0 = bin(int(message_bytes[4]))[2]
            Dsy_1 = bin(int(message_bytes[5]))[2]
            Dsy_2 = bin(int(message_bytes[6]))[2]
            Dsy_3 = bin(int(message_bytes[7]))[2]
            Line_L = bin(int(message_bytes[8]))[2]
            Dsy_1_1 = bin(int(message_bytes[9]))[2]
            Ads_1 = bin(int(message_bytes[10]))[2]
            Ads_2 = bin(int(message_bytes[11]))[2]
            Ads_3 = bin(int(message_bytes[12]))[2]
            Ads_4 = bin(int(message_bytes[13]))[2]
            Ads_5 = bin(int(message_bytes[14]))[2]
            Ads_6 = bin(int(message_bytes[15]))[2]
            Dsy_1_2 = bin(int(message_bytes[16]))[2]
            Two_P = bin(int(message_bytes[17]))[2]
            Dsy_4 = bin(int(message_bytes[18]))[2]
            Line_R = bin(int(message_bytes[19]))[2]
            Dsy_5 = bin(int(message_bytes[20]))[2]
            Dsy_6 = bin(int(message_bytes[21]))[2]
            Dsy_7 = bin(int(message_bytes[22]))[2]
            Horn = bin(int(message_bytes[23]))[2]
            Dsy_8 = bin(int(message_bytes[28]))[2]
            Dsy_9 = bin(int(message_bytes[29]))[2]
            if (start == 'aaaa00' or start == 'aaaa1d' or start == 'aaaa04') and end == '5555':
                if int(Horn) == 1 or message_bytes[23] == 176:
                    horn = True
                if message_bytes[12] == 48 and message_bytes[14] == 16:
                    return {'cmd': 'timeout', 'software': self._software, 
                       'team': 1, 
                       'horn': horn}
                if message_bytes[12] == 16 and message_bytes[14] == 48:
                    return {'cmd': 'timeout', 'software': self._software, 
                       'team': 2, 
                       'horn': horn}
                if self._software == 'litescore_outdoor':
                    if message_bytes[12] == 17 and message_bytes[13] == 0:
                        time = int(message_bytes[26])
                        return {'cmd': 'timeout', 'software': self._software, 
                           'team': 1, 
                           'time': time, 
                           'horn': horn}
                    if message_bytes[12] == 0 and message_bytes[13] == 16 and message_bytes[14] == 16:
                        time = int(message_bytes[26])
                        return {'cmd': 'timeout', 'software': self._software, 
                           'team': 2, 
                           'time': time, 
                           'horn': horn}
                if message_bytes[12] == 48 and message_bytes[14] == 0:
                    player = message_bytes[25]
                    return {'cmd': 'show_serve', 'software': self._software, 
                       'player': player, 
                       'team': '', 
                       'color': '(255,255,255)', 
                       'horn': horn}
                if message_bytes[12] == 0 and message_bytes[14] == 48:
                    player = message_bytes[26]
                    return {'cmd': 'show_serve', 'software': self._software, 
                       'player': player, 
                       'team': '', 
                       'color': '(255,255,255)', 
                       'horn': horn}
                if int(Line_L) > 0 or int(Line_R) > 0:
                    sub1 = int(message_bytes[24])
                    player1 = sub1
                    score1 = int(message_bytes[25])
                    score2 = int(message_bytes[26])
                    sub2 = int(message_bytes[27])
                    player2 = sub2
                    timeout1 = int(Dsy_0) + int(Dsy_1)
                    timeout2 = int(Dsy_6) + int(Dsy_7)
                    set1 = int(Dsy_2) + int(Dsy_3) + int(Dsy_8)
                    set2 = int(Dsy_4) + int(Dsy_5) + int(Dsy_9)
                    if int(Line_L) == 1:
                        serve = '1'
                    if int(Line_R) == 1:
                        serve = '2'
                    return {'cmd': 'match', 'software': self._software, 
                       'score1': score1, 
                       'score2': score2, 
                       'sub1': sub1, 
                       'sub2': sub2, 
                       'player1': player1, 
                       'player2': player2, 
                       'timeout1': timeout1, 
                       'timeout2': timeout2, 
                       'set1': set1, 
                       'set2': set2, 
                       'serve': serve, 
                       'horn': horn}
                '''
                if int(Line_L) == 0 and int(Line_R) == 0 and message_bytes[13] == 16 and message_bytes[14] == 16:
                    countdown = int(message_bytes[26])
                    return {'cmd': 'countdown', 'software': self._software, 
                       'countdown': countdown, 
                       'horn': horn}
                '''
        except Exception as e:
            print('ERROR parse message escoresheet ' + str(e))

    def _processMessage(self, message_bytes):
        protocol_ledbox = False
        if len(message_bytes) > 32:
            protocol_ledbox = True
        try:
            if len(message_bytes) > 0:
                if protocol_ledbox:
                    result = self._parseMessageLedbox(message_bytes)
                else:
                    result = self._parseMessageLitescore(message_bytes)
                print(result)
                if result == None:
                    return
                layout_matchscore = self._config.get('PARAMETERS', 'layout_matchscore_' + result['software'])
                layout_timeout = self._config.get('PARAMETERS', 'layout_timeout')
                self._count_timeout = self._config.getint('PARAMETERS', 'timeout_' + result['software'])
                if result['cmd'] == 'timeout':
                    data = {}
                    if protocol_ledbox:
                        data['cmd'] = 'SetLayout'
                        data['name'] = layout_matchscore
                        data['value'] = []
                        data['value'].append(app.API.createSection('team1', 'animation', ''))
                        data['value'].append(app.API.createSection('team2', 'animation', ''))
                        app.API.SetSections(data)
                    data = {}
                    data['cmd'] = 'SetLayout'
                    data['name'] = layout_matchscore
                    data['value'] = []
                    data['value'].append(app.API.createSection('bg_timeout', 'visible', 'true'))
                    data['value'].append(app.API.createSection('lbl', 'visible', 'true'))
                    data['value'].append(app.API.createSection('timer', 'visible', 'true'))
                    data['value'].append(app.API.createSection('lbl', 'text', 'TIMEOUT'))
                    if result['software'] == 'indoor':
                        if protocol_ledbox:
                            data['value'].append(app.API.createSection('team' + str(result['team']), 'animation_params', "{'count':30,'pause':500,'color1':'','color2':'0,0,0'}"))
                            data['value'].append(app.API.createSection('team' + str(result['team']), 'animation', 'blinking'))
                        if protocol_ledbox == False:
                            data['value'].append(app.API.createSection('score' + str(result['team']), 'animation', 'blinking'))
                    if result['software'] == 'outdoor' or result['software'] == 'litescore_outdoor':
                        data['value'].append(app.API.createSection('timer', 'text', result['time']))
                    app.API.SetSections(data)
                    if result['software'] == 'indoor':
                        self.StartTimeout(None)
                if result['cmd'] == 'countdown':
                    app.current_layout = app.layoutManager.loadLayout('countdown')
                    data = {}
                    data['cmd'] = 'SetLayout'
                    data['name'] = layout_matchscore
                    data['value'] = []
                    data['value'].append(app.API.createSection('timer', 'text', str(result['countdown'])))
                    data['value'].append(app.API.createSection('lbl', 'text', 'COUNTDOWN'))
                    app.API.SetSections(data)
                if result['cmd'] == 'stoptimeout':
                    data = {}
                    data['cmd'] = 'SetLayout'
                    data['name'] = layout_matchscore
                    data['value'] = []
                    data['value'].append(app.API.createSection('bg_timeout', 'visible', False))
                    data['value'].append(app.API.createSection('lbl', 'visible', False))
                    data['value'].append(app.API.createSection('timer', 'visible', False))
                    app.API.SetSections(data)
                if result['cmd'] == 'show_serve':
                    app.current_layout = app.layoutManager.loadLayout('escoresheet_serve_01')
                    data = {}
                    data['cmd'] = 'SetLayout'
                    data['name'] = layout_matchscore
                    data['value'] = []
                    data['value'].append(app.API.createSection('team', 'text', result['team']))
                    data['value'].append(app.API.createSection('player', 'text', result['player']))
                    data['value'].append(app.API.createSection('team', 'color', result['color']))
                    data['value'].append(app.API.createSection('player', 'color', result['color']))
                    app.API.SetSections(data)
                if result['cmd'] == 'challenge':
                    data = {}
                    data['cmd'] = 'SetLayout'
                    data['name'] = layout_matchscore
                    data['value'] = []
                    data['value'].append(app.API.createSection('bg_timeout', 'visible', True))
                    data['value'].append(app.API.createSection('lbl', 'visible', True))
                    data['value'].append(app.API.createSection('timer', 'visible', False))
                    data['value'].append(app.API.createSection('lbl', 'text', 'VIDEO\nCHECK'))
                    app.API.SetSections(data)
                if result['cmd'] == 'match':
                    app.current_layout = app.layoutManager.loadLayout(layout_matchscore)
                    if self._current_timeout != None:
                        self.StopTimeout(None)
                        data = {}
                        data['value'] = []
                        data['value'].append(app.API.createSection('team1', 'animation', ''))
                        data['value'].append(app.API.createSection('team2', 'animation', ''))
                        data['value'].append(app.API.createSection('bg_timeout', 'visible', False))
                        data['value'].append(app.API.createSection('lbl', 'visible', False))
                        data['value'].append(app.API.createSection('timer', 'visible', False))
                        app.API.SetSections(data)
                    self._old_result = result
                    data = {}
                    data['cmd'] = 'SetLayout'
                    data['name'] = layout_matchscore
                    data['value'] = []
                    if protocol_ledbox:
                        data['value'].append(app.API.createSection('team1', 'text', result['team1']))
                        data['value'].append(app.API.createSection('team2', 'text', result['team2']))
                        if app.current_layout.getSection('mode').text == '':
                            data['value'].append(app.API.createSection('team1', 'animation', ''))
                            data['value'].append(app.API.createSection('team2', 'animation', ''))
                        data['value'].append(app.API.createSection('team1', 'color', result['color1']))
                        data['value'].append(app.API.createSection('team2', 'color', result['color2']))
                        data['value'].append(app.API.createSection('bg_score1', 'bordercolor', result['color1']))
                        data['value'].append(app.API.createSection('bg_score2', 'bordercolor', result['color2']))
                    else:
                        data['value'].append(app.API.createSection('score1', 'animation', ''))
                        data['value'].append(app.API.createSection('score2', 'animation', ''))
                    data['value'].append(app.API.createSection('score1', 'text', result['score1']))
                    data['value'].append(app.API.createSection('score2', 'text', result['score2']))
                    if protocol_ledbox:
                        data['value'].append(app.API.createSection('score1', 'color', result['color1']))
                        data['value'].append(app.API.createSection('score2', 'color', result['color2']))
                    if result['software'] == 'indoor':
                        data['value'].append(app.API.createSection('sub1', 'text', result['sub1']))
                        data['value'].append(app.API.createSection('sub2', 'text', result['sub2']))
                    if result['software'] == 'outdoor' or result['software'] == 'litescore_outdoor':
                        if int(result['player1']) > 0:
                            data['value'].append(app.API.createSection('player1', 'text', result['player1']))
                        else:
                            data['value'].append(app.API.createSection('player1', 'text', ''))
                        data['value'].append(app.API.createSection('player1', 'color', result['color1']))
                        
                        
                        if int(result['player2']) > 0:
                            data['value'].append(app.API.createSection('player2', 'text', result['player2']))
                        else:
                            data['value'].append(app.API.createSection('player2', 'text', ''))
                        data['value'].append(app.API.createSection('player2', 'color', result['color2']))
                        
                    
                    if protocol_ledbox:
                        if result['software'] == 'indoor':
                            data['value'].append(app.API.createSection('vc1', 'text', result['challenge1']))
                            data['value'].append(app.API.createSection('vc2', 'text', result['challenge2']))
                    data['value'].append(app.API.createSection('set1', 'text', result['set1']))
                    data['value'].append(app.API.createSection('set2', 'text', result['set2']))
                    if protocol_ledbox:
                        data['value'].append(app.API.createSection('set1', 'color', result['color1']))
                        data['value'].append(app.API.createSection('set2', 'color', result['color2']))
                    data['value'].append(app.API.createSection('timeout1', 'text', result['timeout1']))
                    data['value'].append(app.API.createSection('timeout2', 'text', result['timeout2']))
                    if result['software'] == 'outdoor' or result['software'] == 'litescore_outdoor':
                        data['value'].append(app.API.createSection('timeout1', 'color', result['color1']))
                        data['value'].append(app.API.createSection('timeout2', 'color', result['color2']))

                    if int(result['serve']) == 1:
                        data['value'].append(app.API.createSection('serve1', 'color', '255,255,255'))
                        data['value'].append(app.API.createSection('serve2', 'color', '0,0,0'))
                    if int(result['serve']) == 2:
                        data['value'].append(app.API.createSection('serve2', 'color', '255,255,255'))
                        data['value'].append(app.API.createSection('serve1', 'color', '0,0,0'))
                    if result['serve'] == '':
                        data['value'].append(app.API.createSection('serve1', 'color', '0,0,0'))
                        data['value'].append(app.API.createSection('serve2', 'color', '0,0,0'))
                    data['value'].append(app.API.createSection('bg_timeout', 'visible', False))
                    data['value'].append(app.API.createSection('lbl', 'visible', False))
                    data['value'].append(app.API.createSection('timer', 'visible', False))
                    app.API.SetSections(data)
                if 'horn' in result and result['horn'] == True:
                    data = {}
                    data_horn_value = {}
                    data_horn_value['times'] = 1
                    data_horn_value['sleep'] = 0.5
                    data['value'] = data_horn_value
                    app.API.Horn(data)
                json_data = str(json.dumps(data))
                app.resendMessageBroadcast(json_data, app.getClientById(self._clientid), True, '', True)
        except Exception as e:
            exc_type, exc, tb = sys.exc_info()
            print(exc)
            print('\n\n'.join(traceback.format_tb(tb, limit=5)))
            print('ERROR process message escoresheet ' + str(e))

        return

    def StartTimeout(self, value):
        if self._current_timeout == None:
            self._current_timeout = ThreadTimeout(self, self._clientid)
        if self._thread_timeout == None:
            self._thread_timeout = threading.Thread(target=self._current_timeout.run, args=())
            self._thread_timeout.start()
        return

    def StopTimeout(self, value):
        self._current_timeout.stop()
        self._current_timeout = None
        self._thread_timeout = None
        data = {}
        data['cmd'] = 'StopTimeout'
        data['value'] = ''
        return


class ThreadTimeout(threading.Thread):

    def __init__(self, escoresheetClass, clientid):
        threading.Thread.__init__(self)
        self._stop_event = threading.Event()
        self.t = 0
        self.escoresheetClass = escoresheetClass
        self._clientid = clientid

    def stop(self):
        self.t = 0
        self._stop_event.set()

    def stopped(self):
        return self._stop_event.is_set()

    def run(self):
        timeout = self.escoresheetClass._count_timeout
        self.t = 0
        while not self.stopped():
            data = {}
            data['cmd'] = 'SetSections'
            data['value'] = []
            data['value'].append(app.API.createSection('timer', 'text', str(timeout - self.t)))
            app.API.SetSections(data)
            time.sleep(1)
            if timeout - self.t == 0:
                data = {}
                data['cmd'] = 'SetSections'
                data['value'] = []
                data['value'].append(app.API.createSection('team1', 'animation', ''))
                data['value'].append(app.API.createSection('team2', 'animation', ''))
                data['value'].append(app.API.createSection('bg_timeout', 'visible', False))
                data['value'].append(app.API.createSection('lbl', 'visible', False))
                data['value'].append(app.API.createSection('timer', 'visible', False))
                app.API.SetSections(data)
                self.stop()
                return
            self.t = self.t + 1