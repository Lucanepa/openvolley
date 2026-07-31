# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: ledbox.py
# Compiled at: 2021-08-30 23:16:21
import sys, serial, socket, bluetooth, signal, inspect, threading
from ledboxAPI import ledboxAPI
import ledboxFileUploadServer, ledboxApp as app, RPi.GPIO as GPIO, time, os, xml.etree.ElementTree as ET, BtAutoPair, importlib, glob, testProcedure
from socketStruct import socketStruct
from SocketThreding import SocketThreding
from WebSocketServerClass import WebSocketServerClass
from SerialThreading import SerialThreading

def signal_handler(signal, frame):
    sys.exit(0)
    return


def checkPresenceSerial():
    while True:
        try:
            if app.serialUSBClientConnected == False or app.serialUSBClient.isOpen() == False:
                ports = glob.glob('/dev/ttyUSB*')
                usbport = ''
                if len(ports) > 0:
                    usbport = ports[0]
                    app.serialUSBClient = serial.Serial(usbport)
                    app.serialUSBClient.baudrate = app.Config.getint('USB', 'baud_client')
                    app.serialUSBClientConnected = True
                    serialClientThread = SerialThreading(app.serialUSBClient, 'USB2')
                    serialClientThread.daemon = True
                    serialClientThread.start()
        except Exception as e:
            print('ERROR open USB client ' + str(e))
            app.serialUSBClientConnected = False

        time.sleep(10)

    return


if __name__ == '__main__':
    if os.path.exists('log/') == False:
        os.mkdir('log')
    last_log_number = 0
    first_log_number = 1000
    count_logs = 0
    for f in os.listdir('log'):
        filename, extension = os.path.splitext(f)
        if extension == '.txt':
            count_logs = count_logs + 1
            if last_log_number < int(filename):
                last_log_number = int(filename)
            if first_log_number >= int(filename):
                first_log_number = int(filename)

    app.log_file = 'log/' + str(last_log_number + 1) + '.txt'
    if count_logs >= 30:
        try:
            os.remove('log/' + str(first_log_number) + '.txt')
        except Exception as e:
            pass

    GPIO.setwarnings(False)
    GPIO.setmode(GPIO.BCM)
    GPIO.setup(21, GPIO.OUT)
    app.getNetworkInfo()
    if app.current_eth_ip == 'nd':
        os.system('bin/dhcp')
    language = 'IT'
    app.Config.read('setting.ini')
    app.UserConfig.read('user_setting.ini')
    if app.Config.has_option('DISPLAY', 'width'):
        app.widthOut = app.Config.getint('DISPLAY', 'width')
    if app.Config.has_option('DISPLAY', 'height'):
        app.heightOut = app.Config.getint('DISPLAY', 'height')
    app.deviceName = app.UserConfig.get('GENERAL', 'device')
    app.modifier = app.UserConfig.get('LAYOUT', 'modifier')
    autopair = BtAutoPair.BtAutoPair()
    autopair.enable_pairing(app.UserConfig.get('BLUETOOTH', 'name'))
    if os.path.isfile('manifest.xml'):
        tree = ET.parse('manifest.xml').getroot()
        for child in tree:
            if child.tag == 'version':
                app.version = child.text

    app.mode = app.UserConfig.get('GENERAL', 'mode')
    default_layout = app.UserConfig.get('GENERAL', 'default_layout')
    if app.Config.getboolean('USB', 'enable') == True:
        try:
            app.serialUSB = serial.Serial(app.Config.get('USB', 'port'), timeout=0.05)
            app.serialUSB.baudrate = app.Config.getint('USB', 'baud')
        except Exception as e:
            print('Serial port not opened:' + str(e))

    if app.Config.getboolean('USB', 'client') == True:
        app.serialUSBClientConnected = False
        checkThred = threading.Thread(target=checkPresenceSerial).start()
    app.LEDMatrix2.offset_x = app.UserConfig.getint('GENERAL', 'offset_x')
    app.LEDMatrix2.offset_y = app.UserConfig.getint('GENERAL', 'offset_y')
    app.API = ledboxAPI()
    app.current_layout = app.layoutManager.loadLayout('intro')
    s = socketStruct()
    s.enable = app.UserConfig.getboolean('BLUETOOTH', 'enable')
    s.name = 'Bluetooth'
    s.compressProtocol = True
    s.sock = bluetooth.BluetoothSocket(bluetooth.RFCOMM)
    s.isconnect = False
    s.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.sock.bind(('', bluetooth.PORT_ANY))
    s.sock.listen(1)
    s.port = '0'
    uuid = '00001101-0000-1000-8000-00805F9B34FB'
    bluetooth.advertise_service(s.sock, 'LEDBox', uuid)
    app.server_sock.append(s)
    s = socketStruct()
    try:
        s.enable = app.Config.getboolean('TCP', 'enable')
        s.name = 'TCP/IP'
        s.mode = 'master'
        s.isconnect = False
        s.compressProtocol = True
        s.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.port = app.Config.getint('TCP', 'port')
        s.sock.bind(('0.0.0.0', s.port))
        s.sock.listen(5)
    except:
        pass

    app.server_sock.append(s)
    if app.mode == 'slave':
        s = socketStruct()
        s.enable = True
        s.name = 'TCP/IP'
        s.mode = 'slave'
        s.isconnect = False
        s.compressProtocol = True
        s.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.port_master = app.UserConfig.getint('GENERAL', 'port_master')
        s.ip_master = app.UserConfig.get('GENERAL', 'ip_master')
        app.server_sock.append(s)
    signal.signal(signal.SIGINT, signal_handler)
    if app.Config.getboolean('USB', 'enable') == True:
        try:
            if app.serialUSB.isOpen():
                serialThread = SerialThreading(app.serialUSB, 'USB')
                serialThread.daemon = True
                serialThread.start()
        except NameError as e:
            print('error open serial port: ' + str(e))
        except Exception as e:
            print('error open serial port: ' + str(e))
            exit()

    try:
        app.websocket = WebSocketServerClass(50007)
        app.thread_websocket = threading.Thread(target=app.websocket.run, args=())
        app.thread_websocket.start()
    except:
        pass

    socketThread = []
    for s_sock in app.server_sock:
        if s_sock.enable == True:
            s = SocketThreding(s_sock)
            s.daemon = True
            s.start()
            socketThread.append(s)

    sockUpload = ledboxFileUploadServer.socketFileUploadServer('tcpip')
    sockUpload.daemon = True
    sockUpload.start()
    sockUploadBluetooth = ledboxFileUploadServer.socketFileUploadServer('bluetooth')
    sockUploadBluetooth.daemon = True
    sockUploadBluetooth.start()
    app.loadPlugin()
    app.LEDMatrix2.init()
    testProcedure.checkDeviceVerification()
    app.Debug('Start LEDBox')
    app.API.showInfo()
    os.system('bin/restartled')
    while True:
        time.sleep(0.1)

