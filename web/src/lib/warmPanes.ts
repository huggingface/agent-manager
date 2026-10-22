// Which session panes keep BOTH views warm (the terminal attached under the
// reader, the reader mounted under the terminal): every visible pane, plus the
// `limit` seen most recently before them. Newest first.
//
// Applied on every navigation, including to a route that shows no pane at all
// (Overview, Settings, the mobile list). Then only the last `limit` stay warm:
// leaving a nine-pane group for the Overview must not keep all nine.
export function nextWarmPanes(previous: string[], visible: string[], limit: number,
  exists: (id: string) => boolean = () => true): string[] {
  const next = [...visible, ...previous]
    .filter((id, i, all) => exists(id) && all.indexOf(id) === i)
    .slice(0, visible.length + limit);
  return next.length === previous.length && next.every((id, i) => id === previous[i]) ? previous : next;
}
