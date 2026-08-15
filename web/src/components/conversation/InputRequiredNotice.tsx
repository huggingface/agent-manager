import type { InputRequired } from '../../types';

const detail = (kind: InputRequired['kind']) => {
  if (kind === 'permission') return 'A permission prompt is waiting in the terminal.';
  if (kind === 'question') return 'A question or choice menu is waiting in the terminal.';
  return 'A confirmation dialog is waiting in the terminal.';
};

export default function InputRequiredNotice({ input, onOpenTerminal }: {
  input: InputRequired;
  onOpenTerminal: () => void;
}) {
  return (
    <div className="input-required" role="status">
      <span className="input-required-mark" aria-hidden="true">!</span>
      <span className="input-required-copy">
        <strong>Needs input</strong>
        <span>{detail(input.kind)}</span>
      </span>
      <button type="button" onClick={onOpenTerminal}>open terminal</button>
    </div>
  );
}
