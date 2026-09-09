import { SearchGlyph } from './icons';

export default function OverviewSearchBox({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className={`ov-search${value ? ' has-query' : ''}`} title="Filter agent names and recent trace activity">
      <SearchGlyph />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') { onChange(''); e.currentTarget.blur(); } }}
        placeholder="Filter recent activity…"
        aria-label="Filter agents by recent trace activity"
        autoComplete="off"
        spellCheck={false}
      />
      {value && <button type="button" aria-label="Clear search" title="Clear search" onClick={() => onChange('')}>×</button>}
    </div>
  );
}
