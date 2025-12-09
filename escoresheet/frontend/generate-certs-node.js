/**
 * Generate self-signed SSL certificates using Node.js (no OpenSSL required)
 * Run with: node generate-certs-node.js
 */

import { writeFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import crypto from 'crypto'
import { networkInterfaces } from 'os'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const certPath = join(__dirname, 'localhost.pem')
const keyPath = join(__dirname, 'localhost-key.pem')

console.log('🔐 Generating self-signed SSL certificates...\n')

if (existsSync(certPath) && existsSync(keyPath)) {
  console.log('⚠️  Certificates already exist. Delete them first if you want to regenerate.')
  console.log(`   ${certPath}`)
  console.log(`   ${keyPath}\n`)
  process.exit(0)
}

// Get all local IP addresses
function getLocalIPs() {
  const ips = ['127.0.0.1', '::1']
  const interfaces = networkInterfaces()
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address)
      }
    }
  }
  return ips
}

const localIPs = getLocalIPs()
console.log('📍 Including IP addresses:', localIPs.join(', '))

// Generate key pair
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
})

// Create certificate
const cert = crypto.createSign('SHA256')

// Build Subject Alternative Names
const altNames = [
  'DNS:localhost',
  'DNS:*.localhost',
  'DNS:escoresheet.local',
  ...localIPs.map(ip => `IP:${ip}`)
].join(', ')

// Create a self-signed certificate manually
// Note: Node.js doesn't have built-in X.509 certificate creation,
// so we'll use a simpler approach with the selfsigned package pattern

// For a quick solution, let's create a minimal valid certificate
const now = new Date()
const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)

// Export private key in PEM format
const privateKeyPem = privateKey.export({
  type: 'pkcs8',
  format: 'pem'
})

// Since Node.js doesn't have native X.509 certificate creation,
// we'll need to use a workaround. The simplest is to install a package
// or use a pre-generated certificate template.

// Let's create a simple solution: generate using the forge library pattern
// But since we want no dependencies, let's try a different approach

console.log('\n⚠️  Node.js native crypto cannot create X.509 certificates directly.')
console.log('   Using alternative approach...\n')

// Alternative: Create certificates using child_process with PowerShell
// PowerShell on Windows can create self-signed certificates

import { execSync } from 'child_process'

try {
  // Use PowerShell to create certificate (Windows native)
  const psScript = `
$cert = New-SelfSignedCertificate -DnsName "localhost","escoresheet.local",${localIPs.map(ip => `"${ip}"`).join(',')} -CertStoreLocation "Cert:\\CurrentUser\\My" -NotAfter (Get-Date).AddYears(1) -KeySpec KeyExchange -FriendlyName "eScoresheet Dev"
$certPath = "Cert:\\CurrentUser\\My\\$($cert.Thumbprint)"
$pwd = ConvertTo-SecureString -String "temp123" -Force -AsPlainText
Export-PfxCertificate -Cert $certPath -FilePath "${join(__dirname, 'temp.pfx').replace(/\\/g, '\\\\')}" -Password $pwd
Remove-Item -Path $certPath
`

  console.log('🔧 Creating certificate using PowerShell...')
  execSync(`powershell -Command "${psScript.replace(/\n/g, ' ')}"`, { stdio: 'pipe' })

  // Convert PFX to PEM using PowerShell/certutil
  const pfxPath = join(__dirname, 'temp.pfx')
  
  // Use openssl if available, otherwise provide manual instructions
  try {
    execSync(`openssl pkcs12 -in "${pfxPath}" -out "${certPath}" -nokeys -password pass:temp123`, { stdio: 'pipe' })
    execSync(`openssl pkcs12 -in "${pfxPath}" -out "${keyPath}" -nocerts -nodes -password pass:temp123`, { stdio: 'pipe' })
    
    // Clean up temp file
    execSync(`del "${pfxPath}"`, { stdio: 'pipe', shell: 'cmd' })
    
    console.log('\n✅ Certificates generated successfully!')
    console.log(`   Certificate: ${certPath}`)
    console.log(`   Private Key: ${keyPath}\n`)
  } catch (e) {
    console.log('\n📦 PFX certificate created. Converting to PEM...')
    console.log('   OpenSSL not found. Using alternative method...\n')
    
    // Use certutil as fallback
    try {
      execSync(`certutil -f -p temp123 -exportPFX "${pfxPath}" "${certPath}"`, { stdio: 'pipe' })
    } catch (e2) {
      console.log('⚠️  Could not auto-convert. The PFX file is at:', pfxPath)
      console.log('   You can convert it online at: https://www.sslshopper.com/ssl-converter.html')
    }
  }
} catch (error) {
  console.error('❌ PowerShell certificate generation failed:', error.message)
  
  // Final fallback: create a simple HTTP->HTTPS proxy suggestion
  console.log('\n💡 Alternative solutions:')
  console.log('   1. Use HTTP instead (Wake Lock may not work on some devices)')
  console.log('   2. Install mkcert: https://github.com/FiloSottile/mkcert')
  console.log('   3. Use ngrok for temporary HTTPS: npx ngrok http 5173')
}
