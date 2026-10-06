// Field label for a roster / bench card in portrait (tailwind.css, "Portrait
// data entry"). Hidden in landscape, where the table head names the columns,
// so it takes no grid cell there. The control keeps its own aria-label.
export default function StackLabel({ head = false, children }) {
  return <span aria-hidden="true" className={head ? 'pf-label pf-head' : 'pf-label'}>{children}</span>
}
