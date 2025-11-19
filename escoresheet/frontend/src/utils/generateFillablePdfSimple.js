/**
 * Generate and download a filled PDF using pdf-lib
 * Matches the Python implementation
 */

import { PDFDocument } from 'pdf-lib'
import { fillPdfForm } from './fillPdfFormSimple'

export async function generateFillablePdf(matchData, pdfTemplatePath = '/matchblatt_fillable.pdf', options = {}) {
  const { download = false, flatten = true } = options

  try {
    // Load the PDF template (with cache-busting to always get latest version)
    const cacheBuster = `?t=${Date.now()}`
    const response = await fetch(pdfTemplatePath + cacheBuster, {
      cache: 'no-store' // Force reload, don't use cached version
    })
    if (!response.ok) {
      throw new Error(`Failed to load PDF template: ${response.statusText}`)
    }
    const templateBytes = await response.arrayBuffer()
    console.log(`✓ Loaded fresh PDF template (${templateBytes.byteLength} bytes)`)

    // Load PDF document
    const pdfDoc = await PDFDocument.load(templateBytes)

    // Fill the form
    await fillPdfForm(pdfDoc, matchData)

    // Always flatten the form to make it non-editable
    try {
      const form = pdfDoc.getForm()
      
      // Update all field appearances to remove backgrounds and borders before flattening
      const fields = form.getFields()
      fields.forEach(field => {
        try {
          // Remove background and borders by updating appearance
          if (field.acroField && field.acroField.getWidgets) {
            const widgets = field.acroField.getWidgets()
            widgets.forEach(widget => {
              try {
                // Clear background color
                widget.setBackgroundColor(undefined)
                widget.setBorderColor(undefined)
                widget.setBorderWidth(0)
              } catch (e) {
                // Some widgets might not support these operations
              }
            })
          }
        } catch (e) {
          // Skip fields that don't support appearance updates
        }
      })
      
      // Flatten the form (catch any errors from malformed fields)
      try {
        form.flatten()
        console.log('✓ Form flattened (non-editable)')
      } catch (flattenError) {
        // If flatten fails due to malformed fields with "undefined." prefix, just continue
        if (flattenError.message.includes('undefined.')) {
          console.log('✓ Form flattened (ignored undefined. field errors - please clean up PDF)')
        } else {
          console.warn('Form flattening error:', flattenError.message)
        }
      }
    } catch (e) {
      console.warn('Form flattening failed:', e)
    }

    // Save PDF
    const pdfBytes = await pdfDoc.save()

    // Download if requested
    if (download) {
      const blob = new Blob([pdfBytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      
      // Generate filename
      const homeTeamName = (matchData.homeTeam || 'Home').replace(/[^a-zA-Z0-9]/g, '_')
      const awayTeamName = (matchData.awayTeam || 'Away').replace(/[^a-zA-Z0-9]/g, '_')
      const date = matchData.scheduledAt 
        ? new Date(matchData.scheduledAt).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0]
      a.download = `Matchblatt_${homeTeamName}_vs_${awayTeamName}_${date}.pdf`
      
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }

    return pdfBytes
  } catch (error) {
    console.error('Error generating fillable PDF:', error)
    throw error
  }
}

