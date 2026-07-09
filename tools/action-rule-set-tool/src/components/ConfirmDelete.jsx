import React, { useState } from 'react';

// A delete icon that confirms inline instead of via the browser's native
// confirm() dialog. The native dialog blocks the JS thread and, on dismissal,
// leaves the row's CSS :hover state stranded until the next pointer move — so
// the hover-revealed action buttons get "stuck" visible. Confirming inline
// keeps everything within real pointer state: the row's own :hover still
// governs visibility, and arming disarms as soon as the pointer leaves.
//
// First click arms (the icon turns into a red ✓/✗ pair); ✓ confirms, ✗ or
// moving the pointer off the control cancels.
export default function ConfirmDelete({ onConfirm, title = 'Delete', className = 'row-icon del' }) {
  const [armed, setArmed] = useState(false);

  if (!armed) {
    return (
      <button className={className} onClick={() => setArmed(true)} title={title}>×</button>
    );
  }
  return (
    <span className="confirm-del" onMouseLeave={() => setArmed(false)}>
      <button
        className="row-icon del confirm-yes"
        onClick={() => { setArmed(false); onConfirm(); }}
        title={`${title} — confirm`}
      >✓</button>
      <button
        className="row-icon confirm-no"
        onClick={() => setArmed(false)}
        title="Cancel"
      >✗</button>
    </span>
  );
}
