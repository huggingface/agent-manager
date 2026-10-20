// When a view counts as usable — shared by the startup benchmark and the
// browser suite so a timing and its regression test agree on the definition.
//
// A marker names the first USEFUL content, not the first paint: for the Usage
// page that is a populated trace row, because the page's frame and its skeleton
// rows exist long before any of its seven requests answered (review of #133).
// The API log likewise counts its first real row, not the "loading…" header.
// General/Skills/Cron mark their forms and controls, which are real interaction
// (a job can be created before the job list has loaded).
export const MARK = {
  nav: '.sidebar .row.session',
  overview: '.ov-tile, .ov-card',
  reader: '.pane-reader .cx-prompt',
  composer: '.pane-reader .ov-composer textarea:not([disabled])',
  files: '.files-body.tree .tree-row',
  trace: '.trace-body .cx-prompt, .trace-body .tv-md',
  settings: '.settings-page .setting-row',
  usage: '.usage .traces-table td.tr-agent',
  apilog: '.al-tbl tbody tr, .al-empty',
  skills: '.skills',
  cron: '.cron-form',
};
// The page's frame, as distinct from its data — what a chunk test waits for.
export const FRAME = { usage: '.usage', apilog: '.al-tbl, .al-head' };
