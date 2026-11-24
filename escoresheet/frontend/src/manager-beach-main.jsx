// manager-beach.openvolley.app: OpenBeach's manager console, the same code as
// OpenVolley's with the OpenBeach brand (src/managerBrand.js, src/managerRoot.jsx).
// First: the error reporter listens while the rest loads (utils/errorReport, privacy 1.22)
import './utils/errorReport/boot'
import { setErrorTool } from './utils/errorReport'
import { renderManager } from './managerRoot'

setErrorTool('manager', 'openbeach')
renderManager('beach')
