import { createPortal } from 'react-dom'
import { Modal } from '../../ui'

/**
 * The volleyui Modal for the main app. The kit dialog is z-50, but the app's
 * legacy overlays sit at z-index 1000+ (Modal, MenuList); this wrapper lifts
 * it above them in its own stacking context and scopes the kit preflight
 * (.ov-kit). confirmDialog() and toasts (UiHost, z 100001) still go on top.
 */
export default function KitModal({ open, zIndex = 2000, ...props }) {
  if (!open) return null
  const node = (
    <div className="ov-kit" style={{ position: 'relative', zIndex }}>
      <Modal open={open} {...props} />
    </div>
  )
  return typeof document !== 'undefined' ? createPortal(node, document.body) : node
}
