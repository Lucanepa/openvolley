# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: resetLED.py
# Compiled at: 2021-02-18 19:32:36

from gpiozero import LED
from time import sleep

class resetLED:

    def run(self):
        b12a = '0111111111111111'
        b12b = '0111111111111111'
        b12c = '0111111111111111'
        b12d = '0111111111111111'
        b13a = '0000000001000000'
        b13b = '0000000001000000'
        b13c = '0000000001000000'
        b13d = '0000000001000000'
        xr1 = LED(11)
        xr2 = LED(8)
        xg1 = LED(27)
        xg2 = LED(9)
        xb1 = LED(7)
        xb2 = LED(10)
        xA = LED(22)
        xB = LED(23)
        xC = LED(24)
        xD = LED(25)
        xLAT = LED(4)
        xCLK = LED(17)
        xOE = LED(18)
        xCLK.off()
        xOE.off()
        xA.on()
        xB.off()
        xC.off()
        xD.off()
        xr1.off()
        xr2.off()
        xg1.off()
        xg2.off()
        xb1.off()
        xb2.off()
        b12 = b12a
        b13 = b13a
        max = 256
        for x in range(max):
            y = x % 16
            if b12[y:y + 1] is '0':
                xr1.off()
                xr2.off()
                xg1.off()
                xg2.off()
                xb1.off()
                xb2.off()
            else:
                xr1.on()
                xr2.on()
                xg1.on()
                xg2.on()
                xb1.on()
                xb2.on()
            xCLK.on()
            sleep(0.001)
            xCLK.off()
            sleep(0.001)
            if x > 31:
                b12 = b12b
            if x > 63:
                b12 = b12c
            if x > 95:
                b12 = b12d
            if x == max - 12:
                xLAT.on()

        xLAT.off()
        print('')
        for x in range(max):
            y = x % 16
            if b13[y:y + 1] is '0':
                xr1.off()
                xr2.off()
                xg1.off()
                xg2.off()
                xb1.off()
                xb2.off()
            else:
                xr1.on()
                xr2.on()
                xg1.on()
                xg2.on()
                xb1.on()
                xb2.on()
            xCLK.on()
            sleep(0.001)
            xCLK.off()
            sleep(0.001)
            if x > 31:
                b13 = b13b
            if x > 63:
                b13 = b13c
            if x > 95:
                b13 = b13d
            if x == max - 13:
                xLAT.on()

        xLAT.off()
        xOE.on()
        return


