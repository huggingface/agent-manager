export default function FileWrapToggle({ wrap, onChange }: {
  wrap: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span className="seg file-wrap-toggle mono">
      <button
        type="button"
        className={wrap ? 'on' : ''}
        onClick={() => onChange(!wrap)}
        title={wrap ? 'Long lines are wrapped — click to let them run' : 'Wrap long lines'}
        aria-pressed={wrap}
      >
        wrap
      </button>
    </span>
  );
}
