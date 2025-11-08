const VARS = [
  'w-num','w-dob','w-name',
  'info-c1','info-c2','info-c3','info-c4',
  'off-c1','off-c2','off-c3','off-c4','off-c5'
]

export function applyLayout(config) {
  if (!config) return
  const root = document.documentElement
  for (const key of VARS) {
    if (config[key]) root.style.setProperty(`--${key}`, config[key])
  }
}

export function loadLayout() {
  try {
    const raw = localStorage.getItem('layoutConfig')
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function saveLayout(config) {
  localStorage.setItem('layoutConfig', JSON.stringify(config))
}

export function defaultLayout() {
  return {
    'w-num':'72px','w-dob':'140px','w-name':'200px',
    'info-c1':'22%','info-c2':'22%','info-c3':'22%','info-c4':'22%',
    'off-c1':'15%','off-c2':'15%','off-c3':'15%','off-c4':'15%','off-c5':'15%'
  }
}



