import React from 'react';

export default function ExplainButton({ onClick, title = "Inspect provenance", disabled = false }) {
  return (
    <button
      type="button"
      className="explain-btn"
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onClick) onClick(e);
      }}
    >
      🔍
    </button>
  );
}
