// Hugging Face's mini-header toggle (top right of a Space shown with `header: mini`),
// redrawn as an inline SVG so an instruction can point at it in the text. Used by
// the install page (Locked) and the bucket question (BucketPrompt).
export default function HfHeaderIcon() {
  return (
    <svg className="hf-header-icon" viewBox="0 0 28 26" width="22" height="20" role="img" aria-label="the Space header button">
      <rect x="1" y="1" width="26" height="24" rx="3.5" fill="#fff" stroke="#202937" strokeWidth="1.6" />
      <path d="M1 8V4.5A3.5 3.5 0 0 1 4.5 1h19A3.5 3.5 0 0 1 27 4.5V8z" fill="#202937" />
      <rect x="3" y="3" width="5" height="4" rx="0.5" fill="#377cf6" />
      <circle cx="11.5" cy="5" r="2" fill="#f9d849" />
      <rect x="14.5" y="3" width="5" height="4" rx="0.5" fill="#eb4872" />
      <rect x="21" y="3" width="4.5" height="4" rx="0.5" fill="#7b29f5" />
      <path d="M10.5 14.5l3.5 3.5 3.5-3.5" fill="none" stroke="#202937" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
