import type { Cli } from '../types';

// The one deprecation notice, for an existing session of a CLI that takes no new
// ones (server/src/config.js `deprecated`). The sentence comes from the server
// catalog, so every place says the same thing and nothing here names a CLI.
export const deprecationNote = (cli?: Cli | null) => (cli?.deprecated && cli.deprecationNote) || null;

/** A tag beside a name, with the note as its tooltip; or, as a `banner`, the note on a slim line under a pane's header. */
export default function DeprecatedNotice({ note, banner }: { note?: string | null; banner?: boolean }) {
  return note ? <span className={banner ? 'deprecated-banner' : 'deprecated-tag'} title={note}>{banner ? note : 'deprecated'}</span> : null;
}
