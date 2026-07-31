# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: AutoPairBluetooth.py
# Compiled at: 2021-02-18 19:32:21
import BtAutoPair, configparser
# enable_pairing(name) is required; read the same value ledbox.py passes.
_cfg = configparser.ConfigParser()
_cfg.read('user_setting.ini')
_name = _cfg.get('BLUETOOTH', 'name') if _cfg.has_option('BLUETOOTH', 'name') else 'Ledbox'
autopair = BtAutoPair.BtAutoPair()
autopair.enable_pairing(_name)
