export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 40 40"
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7c8cff" />
          <stop offset="1" stopColor="#4658ff" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="36" height="36" rx="11" fill="url(#lg)" opacity="0.18" />
      <rect x="2" y="2" width="36" height="36" rx="11" stroke="url(#lg)" strokeWidth="1.4" />
      <path
        d="M13 20.5l4.8 4.8L27 16"
        stroke="url(#lg)"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
