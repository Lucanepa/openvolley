# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/testProcedure.py
# Compiled at: 2021-02-18 19:32:39
import ledboxApp as app, time, threading, gzip, io, json, base64, urllib.request, urllib.parse, urllib.error
check_usb = 0
check_display = 0
status = 1
stopThread = False
thread_send = None
thread_display = None
thread_check = None
base = 'http://ledbox.tech4sport.com/'

def run(onlineVerify=False):
    app.isTestMode = True
    app.Debug('RUN TEST LEDbox')
    testDisplay()
    testSerialCable()
    app.Debug(str(onlineVerify))
    if onlineVerify == True:
        thread_check = threading.Thread(target=checkTest)
        thread_check.start()
    return


def checkDeviceVerification():
    global base
    try:
        url = base + 'api.php?task=getVerification&serialnumber=' + app.deviceName
        response = urllib.request.urlopen(url, timeout=2).read()
        device = json.loads(response)
        if int(device['device']['verified']) == 0:
            run(True)
    except:
        pass

    return


def checkTest():
    global check_display
    global check_usb
    global stopThread
    global thread_display
    global thread_send
    while True:
        if check_display > 1 and check_usb > 1:
            app.Debug('Test OK')
            stopThread = True
            thread_display.join()
            thread_send.join()
            app.current_layout = app.layoutManager.loadLayout('waiting')
            r = 'Display OK\nUSB OK'
            result = base64.b64encode(bytes(r))
            verify = True
            url = base + 'api.php?task=setVerification&serialnumber=' + app.deviceName + '&verify=' + str(verify) + '&result=' + result
            response = urllib.request.urlopen(url).read()
            app.Debug('Verification Send to ' + url)
            break

    return


def testDisplay():
    global thread_display
    thread_display = threading.Thread(target=changeColorDisplay)
    thread_display.start()
    return


def testSerialCable():
    global thread_send
    thread_send = threading.Thread(target=sendMessageFromUSB)
    thread_send.start()
    return


def changeColorDisplay():
    global check_display
    while True:
        if stopThread == True:
            break
        app.current_layout = app.layoutManager.loadLayout('test')
        app.current_layout.setSection('rectangle', 'color', '255,0,0')
        time.sleep(1)
        app.current_layout.setSection('rectangle', 'color', '0,255,0')
        time.sleep(1)
        app.current_layout.setSection('rectangle', 'color', '0,0,255')
        time.sleep(1)
        app.current_layout.setSection('rectangle', 'color', '255,255,255')
        time.sleep(1)
        check_display = check_display + 1

    return


def sendMessageFromUSB():
    global status
    while True:
        if stopThread == True:
            break
        if status == 1:
            data = {}
            data['cmd'] = 'CheckTest'
            data['value'] = 'test'
            json_data = json.dumps(data)
            app.Debug('SEND from USB: ' + json_data)
            time.sleep(2)
            out = io.BytesIO()
            with gzip.GzipFile(fileobj=out, mode='wb') as gz:
                gz.write(json_data)
                gz.close()
                coding_message = out.getvalue()
            try:
                app.serialUSBClient.write(coding_message + '\r\n')
            except Exception as e:
                app.Debug('ERROR SEND USB ' + str(e))
                print('ERROR - cable disconnected ' + str(e))

            status = 0

    return


def checkUSBSendend(value):
    global check_usb
    global status
    status = 1
    data = {}
    data_value = {}
    data_value['times'] = 1
    data_value['sleep'] = 0.5
    data['value'] = data_value
    app.API.Horn(data)
    check_usb = check_usb + 1
    return


