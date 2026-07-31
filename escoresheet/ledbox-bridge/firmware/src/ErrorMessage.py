# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/ErrorMessage.py
# Compiled at: 2021-02-18 19:32:22


class ErrorMessageStruct:

    def __init__(self, code=0, message=''):
        self.error_code = code
        self.error_message = message
        return


def getErrorMessage():
    em = ErrorMessageStruct()
    return em


def getMessage(code, args=None):
    if args is not None and not isinstance(args, str):
        args = ', '.join(str(x) for x in args) if isinstance(args, (list, tuple)) else str(args)
    em = ErrorMessageStruct()
    em.error_code = code
    if code == 1:
        em.error_message = 'API not avaible'
    if code == 2:
        em.error_message = 'message not formatted in JSON'
    if code == 3:
        em.error_message = "key 'value' not defined"
    if code == 4:
        em.error_message = "key 'cmd' not defined"
    if code == 5:
        em.error_message = 'layout ' + args + ' not present in device'
    if code == 6:
        em.error_message = 'section ' + args + ' not found'
    if code == 7:
        em.error_message = 'format XML layout not correct'
    if code == 8:
        em.error_message = 'App not compatible'
    if code == 9:
        em.error_message = 'key ' + args + ' not defined'
    if code == 99:
        em.error_message = 'Upload not complete'
    print(str(code) + ' - ' + em.error_message)
    return em


