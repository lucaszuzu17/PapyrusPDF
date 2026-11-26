// Marca vetorial fiel ao ícone oficial (Monograma P Dobrado #2 e Ícone de Arquivo .pdf C).

export function PapyrusLogo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <rect x="1.2" y="1.2" width="69.6" height="69.6" rx="15" fill="#1e242b" stroke="#3b4554" strokeWidth="2.2" />
      <g transform="translate(15.8 10)">
        <path d="M26.2 11.4H38.8C41.4 15.4 41.6 20.6 39.4 24.8L26.6 26.4C29 22 28.8 15.6 26.2 11.4Z" fill="#c93b2b" />
        <path d="M26.2 11.4H38.8C39.7 12.8 40.3 14.3 40.6 15.8C36.2 14.4 31.4 14.4 27.8 15.6C27.3 14 26.8 12.6 26.2 11.4Z" fill="#8b2217" />
        <path d="M27.9 22.8C32.8 23.8 37.2 23 40.4 20.6C40.1 22.4 39.6 24 38.8 25.4L26.6 26.4C27.2 25.3 27.6 24 27.9 22.8Z" fill="#8b2217" />
        <path d="M22.8 17.8C19.6 17.8 18 20.4 19 23.2C19.9 25.4 23.2 25.6 25.2 24.2C25.9 23.6 25.9 22.2 25.4 20.4C25 18.8 24.2 17.8 22.8 17.8Z" fill="#c93b2b" />
        <path d="M23.8 17.8C19.4 17.8 15.6 20.6 15.4 25.8C15.2 32 20.4 36.4 27.2 36C34.6 35.6 40.2 30.4 40.7 21.4C38.6 24.8 34.4 26.4 28.4 26.4C24.2 26.4 21.4 25.2 21.4 22.4C21.4 20.4 22.5 19.2 23.8 19.2C24.6 19.2 24.6 17.8 23.8 17.8Z" fill="#f6ecdc" />
        <path d="M11.8 0H25.2C30.6 0 35.2 3.8 39 11.8H11.8V0Z" fill="#f6ecdc" />
        <path d="M11.8 0L14.8 11.8H11.8V0Z" fill="#e3d6c0" />
        <path d="M0 11.8H11.8V40.2L0 52V11.8Z" fill="#f6ecdc" />
        <path d="M0 11.8H11.8V15.2L0 11.8Z" fill="#e3d6c0" />
        <path d="M0 11.8L11.8 0V11.8H0Z" fill="#d4a24c" />
        <path d="M0 52L11.8 40.2V52H0Z" fill="#d4a24c" />
      </g>
    </svg>
  );
}

export function PdfFileBadge({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" aria-hidden="true">
      <path d="M20.6 4H49L64 19V63.4C64 65.94 61.94 68 59.4 68H20.6C18.06 68 16 65.94 16 63.4V8.6C16 6.06 18.06 4 20.6 4Z" fill="#f6ecdc" stroke="#8e8678" strokeWidth="1.8" />
      <path d="M49 4V16.6C49 17.93 50.07 19 51.4 19H64L49 4Z" fill="#d4a24c" />
      <path d="M7.4 35.5H16V42.5L7.4 35.5Z" fill="#8b2217" />
      <rect x="7" y="18.5" width="38.5" height="17" rx="2.6" fill="#c93b2b" />
      <text x="26.2" y="31" textAnchor="middle" fill="#f6ecdc" fontSize="11.4" fontWeight="700" fontFamily="Segoe UI, Arial, sans-serif">PDF</text>
      <g transform="translate(36.2 37.2) scale(0.51)">
        <path d="M26.2 11.4H38.8C41.4 15.4 41.6 20.6 39.4 24.8L26.6 26.4C29 22 28.8 15.6 26.2 11.4Z" fill="#c93b2b" />
        <path d="M22.8 17.8C19.6 17.8 18 20.4 19 23.2C19.9 25.4 23.2 25.6 25.2 24.2C25.9 23.6 25.9 22.2 25.4 20.4C25 18.8 24.2 17.8 22.8 17.8Z" fill="#c93b2b" />
        <path d="M23.8 17.8C19.4 17.8 15.6 20.6 15.4 25.8C15.2 32 20.4 36.4 27.2 36C34.6 35.6 40.2 30.4 40.7 21.4C38.6 24.8 34.4 26.4 28.4 26.4C24.2 26.4 21.4 25.2 21.4 22.4C21.4 20.4 22.5 19.2 23.8 19.2C24.6 19.2 24.6 17.8 23.8 17.8Z" fill="#1e242b" />
        <path d="M11.8 0H25.2C30.6 0 35.2 3.8 39 11.8H11.8V0Z" fill="#1e242b" />
        <path d="M0 11.8H11.8V40.2L0 52V11.8Z" fill="#1e242b" />
        <path d="M0 11.8L11.8 0V11.8H0Z" fill="#d4a24c" />
        <path d="M0 52L11.8 40.2V52H0Z" fill="#d4a24c" />
      </g>
    </svg>
  );
}
