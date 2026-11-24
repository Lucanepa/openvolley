// The manager's page: the app's stylesheet (no Tailwind preflight, its legacy
// layer), the sheet embedded under a bar, as Rebuild PDF draws it.
import '../../src/tailwind.css'
import { mount } from './mount'

mount({ embedded: true })
