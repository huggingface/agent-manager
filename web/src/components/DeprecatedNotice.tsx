import type { Cli } from '../types';

// The one deprecation notice, for an existing session of a CLI that takes no new
// ones (server/src/config.js `deprecated`). The sentence comes from the server
// catalog, so every place says the same thing and nothing here names a CLI.
export const deprecationNote = (cli?: Cli | null): string | null =>
  cli?.deprecated ? (cli.deprecationNote || `${cli.label} is deprecated.`) : null;

/** A marker beside the name on a sidebar row or an Overview card; the note is its tooltip. */
export function DeprecatedTag({ note }: { note?: string | null }) {
  return note ? <span className="deprecated-tag" title={note}>deprecated</span> : null;
}

/** A slim line under a pane's header. */
export function DeprecatedBanner({ note }: { note?: string | null }) {
  return note ? <div className="deprecated-banner" role="note">{note}</div> : null;
}
