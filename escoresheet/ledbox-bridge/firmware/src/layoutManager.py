# uncompyle6 version 3.9.3
# Python bytecode version base 2.7 (62211)
# Decompiled from: Python 3.13.5 (main, Jul 15 2026, 20:25:40) [GCC 14.2.0]
# Embedded file name: /home/pi/ledbox/layoutManager.py
# Compiled at: 2021-02-18 19:32:24
import ErrorMessage, os.path, xml.etree.ElementTree as ET, ErrorMessage, json, ledboxApp as app
path_layout = 'layout/'
layouts = []

class layout:
    name = None
    xml = None
    modifier = None
    sections = []
    ischange = False
    current_video_name = None

    def __init__(self, xml):
        self.xml = xml
        self.name = xml.attrib.get('name')
        if 'modifier' in xml.attrib:
            self.modifier = xml.attrib.get('modifier')
        self.sections = []
        self.ischange = False
        return

    def parse(self):
        """Effettua il parsing del xml"""
        for child in self.xml:
            s = section()
            s.name = child.attrib['name']
            if child.text != None:
                s.text = child.text
            s.typesection = child.attrib['type']
            s.setx(int(child.attrib['x']))
            s.sety(int(child.attrib['y']))
            s.setX(s.getx())
            s.setY(s.gety())
            if 'fontsize' in child.attrib:
                s.fontsize = int(child.attrib['fontsize'])
            if 'maxlength' in child.attrib:
                s.maxlength = int(child.attrib['maxlength'])
            if 'align' in child.attrib:
                s.align = child.attrib['align']
            if 'valign' in child.attrib:
                s.valign = child.attrib['valign']
            if 'color' in child.attrib:
                s.color = self.getColor(child.attrib['color'])
            if 'bordercolor' in child.attrib:
                s.bordercolor = self.getColor(child.attrib['bordercolor'])
            if 'src' in child.attrib:
                s.src = child.attrib['src']
            if 'width' in child.attrib:
                s.width = int(child.attrib['width'])
            if 'height' in child.attrib:
                s.height = int(child.attrib['height'])
            if 'animation' in child.attrib:
                s.animation = child.attrib['animation']
            if 'animation_params' in child.attrib:
                if child.attrib['animation_params'] != '':
                    s.animation_params = json.loads(child.attrib['animation_params'].replace("'", '"'))
                else:
                    s.animation_params = {}
            if 'private' in child.attrib:
                s.private = self.str2bool(child.attrib['private'])
            if 'visible' in child.attrib:
                s.visible = self.str2bool(child.attrib['visible'])
            if 'parameter' in child.attrib:
                s.parameter = json.loads(child.attrib['parameter'].replace("'", '"'))
            if 'enable' in child.attrib:
                s.enable = self.str2bool(child.attrib['enable'])
            if 'type' in child.attrib:
                if child.attrib['type'] == 'video':
                    s.isvideo = True
                else:
                    s.isvideo = False
            self.sections.append(s)

        return

    def str2bool(self, text):
        try:
            if text.lower() == 'false':
                return False
            if text.lower() == 'true':
                return True
        except:
            return text

        return text

    def getSection(self, name):
        for s in self.sections:
            if s.name == name:
                return s

        print("section '" + name + "' no found ")
        return section()

    def getSections(self):
        result = []
        for s in self.sections:
            sec = s.getSection()
            if sec != None:
                result.append(sec)

        return result

    def setSection(self, name, attrib, value):
        for s in self.sections:
            if s.name == name:
                if attrib == 'color':
                    value = self.getColor(value)
                if attrib == 'bordercolor':
                    value = self.getColor(value)
                if attrib == 'parameter':
                    if value == '':
                        value = {}
                    else:
                        value = json.loads(value.replace("'", '"'))
                if attrib == 'animation_params':
                    if value == '':
                        value = {}
                    else:
                        value = json.loads(value.replace("'", '"'))
                setattr(s, attrib, self.str2bool(value))
                self.ischange = True
                return True

        return ErrorMessage.getMessage(6, name)

    def replaceSection(self, name, section):
        for s in self.sections:
            if s.name == name:
                s = section
                self.ischange = True
                return True

        return ErrorMessage.getMessage(6)

    def getColor(self, color):
        r, g, b = (255, 255, 255)
        try:
            r, g, b = color.split(',')
        except:
            r, g, b = (255, 255, 255)

        return (
         int(r), int(g), int(b))


class section:
    name = ''
    text = ''
    typesection = ''
    fontsize = 0
    maxlength = 0
    align = 'left'
    valign = 'top'
    color = (0, 0, 0)
    bordercolor = (0, 0, 0)
    src = ''
    width = 192
    height = 64
    video = None
    frame = 0
    current_video_name = None
    visible = True
    __x = 0
    __y = 0
    animation = ''
    animation_params = {}
    __X = 0
    __Y = 0
    private = False
    parameter = {}
    enable = True

    def __init__(self, *args, **kwargs):
        self.name = ''
        self.text = ''
        self.typesection = ''
        self.fontsize = 0
        self.maxlength = 0
        self.align = 'left'
        self.valign = 'top'
        self.color = (0, 0, 0)
        self.bordercolor = (0, 0, 0)
        self.src = ''
        self.width = 192
        self.height = 64
        self.video = None
        self.frame = 0
        self.current_video_name = None
        self.__x = 0
        self.__y = 0
        self.animation = ''
        self.animation_params = {}
        self.__X = 0
        self.__Y = 0
        self.private = False
        self.visible = True
        self.parameter = {}
        self.enable = True
        return

    def setx(self, value):
        self.__x = value
        return

    def getx(self):
        return self.__x

    def sety(self, value):
        self.__y = value
        return

    def gety(self):
        return self.__y

    def setX(self, value):
        self.__X = value
        return

    def getX(self):
        return self.__X

    def setY(self, value):
        self.__Y = value
        return

    def getY(self):
        return self.__Y

    def getColorString(self):
        return str(self.color[0]) + ',' + str(self.color[1]) + ',' + str(self.color[2])

    def getSection(self):
        if self.private == True:
            return
        else:
            data = {}
            data['name'] = self.name
            data['value'] = []
            data_attrib = {}
            data_attrib['attrib'] = 'text'
            data_attrib['value'] = self.text
            data['value'].append(data_attrib)
            data_attrib = {}
            data_attrib['attrib'] = 'color'
            data_attrib['value'] = self.getColorString()
            data['value'].append(data_attrib)
            if self.typesection == 'counter' and self.parameter != None:
                data_attrib = {}
                data_attrib['attrib'] = 'parameter'
                data_attrib['value'] = self.parameter
                data['value'].append(data_attrib)
            return data
            return


def loadSystemLayout():
    path_ls = path_layout + '/system/'
    for f in os.listdir(path_ls):
        path_file = path_ls + f
        if os.path.isfile(path_file):
            filename, extension = f.split('.')
            if extension == 'xml':
                tree = ET.parse(path_file).getroot()
                l = layout(tree)
                l.parse()
                layouts.append(l)

    return


def loadLayout(name, force_reload=False):
    """Carica il layout"""
    if force_reload == False:
        for lay in layouts:
            if lay.name == name and lay.modifier == app.modifier:
                lay.ischange = True
                return lay

    if app.modifier != '':
        l = scanLayoutFolder(name, force_reload, app.modifier)
        if l == None:
            l = scanLayoutFolder(name, force_reload)
    else:
        l = scanLayoutFolder(name, force_reload)
    if l == None:
        return ErrorMessage.getMessage(5, name)
    else:
        return l
        return ErrorMessage.getMessage(5, name)
        return


def scanLayoutFolder(name, force_reload, mod=''):
    l = None
    directories = [path_layout, path_layout + 'system/']
    for dir in directories:
        for f in os.listdir(dir):
            path_file = dir + f
            if os.path.isfile(path_file):
                filename, extension = f.split('.')
                if extension == 'xml':
                    tree = ET.parse(path_file).getroot()
                    if tree.attrib.get('name') == name or f == name:
                        layout_modifiers = ''
                        if 'modifier' in tree.attrib:
                            layout_modifiers = tree.attrib.get('modifier')
                        if layout_modifiers == mod:
                            l = layout(tree)
                        if l != None:
                            l.parse()
                            if force_reload == False:
                                layouts.append(l)
                            l.ischange = True
                            return l

    return l


