import type { InputRequired } from '../../types';

const detail = (kind: InputRequired['kind']) => {
  if (kind === 'permission') return 'permission prompt waiting in the terminal';
  if (kind === 'question') return 'question or choice menu waiting in the terminal';
  return 'confirmation dialog waiting in the terminal';
};

export default function InputRequiredNotice({ input, onOpenTerminal }: {
  input: InputRequired;
  onOpenTerminal: () => void;
}) {
  return (
    <div className="input-required" role="status">
      <span className="input-required-mark" aria-hidden="true">!</span>
      <span className="input-required-copy">
        <span className="input-required-label">needs input</span> · {detail(input.kind)}
      </span>
      <button type="button" onClick={onOpenTerminal}>open terminal</button>
    </div>
  );
}
