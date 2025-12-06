/**
 * Generate self-signed SSL certificates for development
 * Run with: node generate-certs.js
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const certPath = join(__dirname, 'localhost.pem')
const keyPath = join(__dirname, 'localhost-key.pem')

console.log('🔐 Generating self-signed SSL certificates for localhost...\n')

if (existsSync(certPath) && existsSync(keyPath)) {
  console.log('⚠️  Certificates already exist. Delete them first if you want to regenerate.')
  console.log(`   ${certPath}`)
  console.log(`   ${keyPath}\n`)
  process.exit(0)
}

  try {
    // Generate self-signed certificate using OpenSSL
    // Valid for 365 days, for localhost, escoresheet.local, and 127.0.0.1
    const command = `openssl req -x509 -newkey rsa:4096 -nodes -keyout "${keyPath}" -out "${certPath}" -days 365 -subj "/C=CH/ST=State/L=City/O=eScoresheet/CN=escoresheet.local" -addext "subjectAltName=DNS:localhost,DNS:*.localhost,DNS:escoresheet.local,DNS:*.escoresheet.local,IP:127.0.0.1,IP:::1"`
    
    execSync(command, { stdio: 'inherit' })
  
  console.log('\n✅ Certificates generated successfully!')
  console.log(`   Certificate: ${certPath}`)
  console.log(`   Private Key: ${keyPath}\n`)
  console.log('📝 Note: These are self-signed certificates for development only.')
  console.log('   Your browser will show a security warning - this is normal for self-signed certs.\n')
} catch (error) {
  console.error('\n❌ Error generating certificates:', error.message)
  console.log('\n💡 Alternative: Install OpenSSL or use mkcert for trusted local certificates:')
  console.log('   - Windows: choco install openssl')
  console.log('   - Mac: brew install openssl')
  console.log('   - Linux: sudo apt-get install openssl\n')
  process.exit(1)
}
