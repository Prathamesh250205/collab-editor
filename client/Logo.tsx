// Mark: two text cursors (coral and cyan) overlapping, i.e. two people in one document.
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <rect x="5" y="3" width="3" height="18" rx="1.5" fill="#ff6b4a" />
      <rect x="2" y="3" width="9" height="2.6" rx="1.3" fill="#ff6b4a" />
      <rect x="14" y="3" width="3" height="18" rx="1.5" fill="#4fd1ff" opacity="0.9" />
      <rect x="11" y="18.4" width="9" height="2.6" rx="1.3" fill="#4fd1ff" opacity="0.9" />
    </svg>
  )
}
