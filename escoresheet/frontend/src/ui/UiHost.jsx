// Mount once per React root, as a SIBLING of the routed page (not a wrapper).
// svrz_rc src/components/ui/index.tsx:1-20, main.tsx:265-269.
//
//   <ErrorBoundary>
//     <App />
//     <UiHost />
//     <ConnectionBanner state={net} />
//   </ErrorBoundary>
import { ConfirmDialog } from './ConfirmDialog.jsx';
import { ToastStack } from './Toast.jsx';

export { confirmDialog, toast, dismissToast } from './uiStore.js';

export function UiHost() {
  return (
    <>
      <ConfirmDialog />
      <ToastStack />
    </>
  );
}

export default UiHost;
