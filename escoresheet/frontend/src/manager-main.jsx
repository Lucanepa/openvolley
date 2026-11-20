// manager.openvolley.app: OpenVolley's manager console (src/managerRoot.jsx).
// First: the error reporter listens while the rest loads (utils/errorReport, privacy 1.22)
import './utils/errorReport/boot'
import { setErrorTool } from './utils/errorReport'
import { renderManager } from './managerRoot'

setErrorTool('manager', 'openvolley')
renderManager('indoor')
