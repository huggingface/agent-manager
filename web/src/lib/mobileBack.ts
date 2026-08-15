import { isPassive } from '../types';

/**
 * Does the staged pane carry its own way back, in its header?
 *
 * On a phone the app is two full-screen views — the list, or one staged pane —
 * so a staged pane needs a way back to the list. It used to be a bar above the
 * pane holding an arrow and the session's name, and that bar cost a row of the
 * one dimension a terminal actually needs. An agent's pane header already has
 * an identity block (logo and status) on its left and already shows the name,
 * so the arrow goes there and the bar goes away.
 *
 * The bar survives wherever nothing else can hold the arrow:
 *  - a group, whose bar is also the chip pager between its agents;
 *  - the Overview, which has no pane header at all;
 *  - the files and trace panes, whose flat headers have no identity block —
 *    and whose leftmost spot is, for files, already a back button to the file
 *    list, so a second arrow there would be two backs meaning two things.
 *
 * Desktop never stages and never asks: the sidebar is always on screen.
 */
export const paneOwnsBack = (
  { isMobile, staged, inGroup, cli }: {
    isMobile: boolean;
    staged: boolean;
    inGroup: boolean;
    cli?: string | null;
  },
): boolean => isMobile && staged && !inGroup && !!cli && !isPassive(cli);
