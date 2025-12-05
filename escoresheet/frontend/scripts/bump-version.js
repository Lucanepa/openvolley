import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Read package.json
const packagePath = resolve(__dirname, '../package.json')
const packageJson = JSON.parse(readFileSync(packagePath, 'utf-8'))

// Parse version (e.g., "0.1.0" -> [0, 1, 0])
const oldVersion = packageJson.version
const versionParts = packageJson.version.split('.').map(Number)

// Increment patch version (0.1.0 -> 0.1.1)
versionParts[2] = (versionParts[2] || 0) + 1

// Reconstruct version string
const newVersion = versionParts.join('.')

// Update package.json
packageJson.version = newVersion
writeFileSync(packagePath, JSON.stringify(packageJson, null, 2) + '\n')

console.log(`Version bumped from ${oldVersion} to ${newVersion}`)
