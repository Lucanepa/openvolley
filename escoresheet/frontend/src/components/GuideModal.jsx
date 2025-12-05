import { useState, useEffect } from 'react'
import Modal from './Modal'

export default function GuideModal({ open, onClose }) {
  const [guideContent, setGuideContent] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (open) {
      // Fetch the USER_GUIDE.md file from public directory
      // Try multiple paths to handle different deployment scenarios
      const basePath = import.meta.env.BASE_URL || '/'
      const paths = [
        `${basePath}USER_GUIDE.md`.replace(/\/\//g, '/'), // Normalize double slashes
        '/USER_GUIDE.md',
        './USER_GUIDE.md'
      ]
      
      const tryFetch = async (pathIndex) => {
        if (pathIndex >= paths.length) {
          setGuideContent('Error loading user guide. Please check the USER_GUIDE.md file.')
          setLoading(false)
          return
        }
        
        try {
          const response = await fetch(paths[pathIndex])
          if (response.ok) {
            const text = await response.text()
            if (text) {
              setGuideContent(text)
              setLoading(false)
              return
            }
          }
          // If this path failed, try the next one
          tryFetch(pathIndex + 1)
        } catch (error) {
          // Try next path
          tryFetch(pathIndex + 1)
        }
      }
      
      tryFetch(0)
    }
  }, [open])

  // Simple markdown to HTML converter
  const renderMarkdown = (text) => {
    if (!text) return ''
    
    let html = text
      // Horizontal rules
      .replace(/^---$/gm, '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 24px 0;" />')
      // Headers (order matters - do h4 before h3 before h2 before h1)
      .replace(/^#### (.*$)/gim, '<h4 style="font-size: 16px; font-weight: 600; margin-top: 20px; margin-bottom: 12px;">$1</h4>')
      .replace(/^### (.*$)/gim, '<h3 style="font-size: 18px; font-weight: 600; margin-top: 24px; margin-bottom: 12px;">$1</h3>')
      .replace(/^## (.*$)/gim, '<h2 style="font-size: 20px; font-weight: 700; margin-top: 28px; margin-bottom: 16px;">$1</h2>')
      .replace(/^# (.*$)/gim, '<h1 style="font-size: 24px; font-weight: 700; margin-top: 32px; margin-bottom: 20px;">$1</h1>')
    
    // Process lists (need to handle multi-line)
    const lines = html.split('\n')
    const processedLines = []
    let inList = false
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const listMatch = line.match(/^(\d+)\.\s+(.*)$/) || line.match(/^[-*]\s+(.*)$/)
      
      if (listMatch) {
        if (!inList) {
          processedLines.push('<ul style="padding-left: 24px; margin-bottom: 12px; list-style-type: disc;">')
          inList = true
        }
        processedLines.push(`<li style="margin-bottom: 4px;">${listMatch[2] || listMatch[1]}</li>`)
      } else {
        if (inList) {
          processedLines.push('</ul>')
          inList = false
        }
        if (line.trim()) {
          // Process bold and code in regular lines
          let processedLine = line
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/`([^`]+)`/g, '<code style="background: rgba(255,255,255,0.1); padding: 2px 4px; border-radius: 4px;">$1</code>')
          processedLines.push(processedLine)
        } else {
          processedLines.push('<br />')
        }
      }
    }
    
    if (inList) {
      processedLines.push('</ul>')
    }
    
    html = processedLines.join('\n')
    
    // Wrap in paragraphs for non-header, non-list lines
    html = html.split('\n').map(line => {
      if (line.startsWith('<h') || line.startsWith('<ul') || line.startsWith('</ul') || 
          line.startsWith('<li') || line.startsWith('</li') || line.startsWith('<hr') ||
          line.startsWith('<br') || !line.trim()) {
        return line
      }
      return `<p style="margin-bottom: 12px;">${line}</p>`
    }).join('\n')
    
    return html
  }

  return (
    <Modal
      title="User Guide"
      open={open}
      onClose={onClose}
      width={900}
    >
      <div style={{ padding: '24px', maxHeight: '80vh', overflow: 'auto' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--muted)' }}>
            Loading guide...
          </div>
        ) : (
          <div 
            style={{ 
              fontSize: '14px', 
              lineHeight: '1.8',
              color: 'var(--text)'
            }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(guideContent) }}
          />
        )}
      </div>
    </Modal>
  )
}
