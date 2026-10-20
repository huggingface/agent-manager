import { ApiError } from './api-errors.js';
import { codexBindings } from './codex-context.js';
import { CodexBindingError, validThreadId } from './codex-bindings.js';

// Host policy, not endpoint liveness: an unavailable daemon must never turn a
// shared installation back into an independent writer. Socket configuration
// alone is also used by standalone observation-only installations.
export const sharedCodexMode = () => process.env.AM_CODEX_BINDINGS_PILOT === '1'
  || process.env.AM_CODEX_SHARED_CREATE === '1';

// What a Codex session may do when we cannot read the bindings file.
//
// An earlier version of this answered "no binding can exist" from the session
// row having no verified thread pin. That was wrong: sessions.json and
// codex-bindings.json are separate durable files and are not restored
// together, so a partial bucket restore (or a hand edit) can leave a row with
// no pin beside a record that still binds it.
//
// The usable evidence is not the row, it is the COMMAND. Per runner.commandFor,
// a Codex launch can attach to an existing conversation three ways: a pinned
// `resume <id>` when the rollout file is present, `resume --last`, which scopes
// to the working directory and can therefore land on a bound thread that is the
// newest rollout there, and nothing else. A session that has never started, has
// no pin and no rollout gets `exec codex` — a NEW conversation, which cannot
// become a second writer on a thread the shared server owns, whatever the
// unreadable file says.
//
// So refuse what could resume and allow what cannot. `codexSharedOnly` and the
// pilot flags stay in the refusal: an imported reference has an import to
// finish, and a shared host has no business starting standalone terminals.
const couldResume = (session) => session.everStarted === true
  || !!session.codexSessionId || !!session.codexRollout;

export function unsafeWithoutBindings(session) {
  return session.codexSharedOnly === true || sharedCodexMode() || couldResume(session);
}

/**
 * The binding if one can be read, null if there is none OR the file cannot be
 * read. Never throws. Only for callers whose answer cannot start a writer:
 * display, and stopping a pane.
 */
export function bindingIfKnown(session, bindings = codexBindings) {
  try { return bindings.forSession(session?.id) || null; } catch { return null; }
}

// A bindings file we cannot read is not a bare 503.
//
// 409, not 503, so the operator actually reads this: errorEnvelope replaces the
// body of every 5xx with "The request could not be completed. Please try again."
// and keeps only a relative `path` detail, so the old 503 could not say what was
// wrong however it was worded. A record file the operator owns and must repair
// is a conflict with current state, not a transient server fault — retrying
// unchanged will fail identically.
//
// The absolute path goes to the server log; the response carries the file name
// alone, which is what publicFailurePath admits.
function bindingsUnreadable(bindings, cause) {
  const reason = cause instanceof CodexBindingError ? cause.code : 'bindings-unavailable';
  console.warn(`[codex] ${bindings.file} could not be read (${reason}); refusing standalone Codex launches that may be bound`);
  return new ApiError(409, 'codex-bindings-unreadable',
    'codex-bindings.json could not be read, so AM cannot tell whether this Codex session is bound to a shared thread '
    + 'and will not resume one that could become a second writer on a thread the shared server owns. '
    + 'Repair that file, or remove it to unbind every shared task (each can then be added again), and retry. '
    + 'Agents other than Codex are unaffected.',
    { reason, details: [{ field: 'path', message: 'codex-bindings.json' }] });
}

/**
 * This session's binding, or null. A read failure throws ONLY when the session
 * could actually be bound: on a host that never ran the pilot the file does not
 * exist (read() answers [] for ENOENT), so an unreadable one means the host has
 * bindings — and an ordinary unpinned Codex session still must not be held
 * hostage by it.
 */
export function sharedBinding(session, bindings = codexBindings) {
  try { return bindings.forSession(session.id); }
  catch (error) {
    if (unsafeWithoutBindings(session)) throw bindingsUnreadable(bindings, error);
    return null;
  }
}

/**
 * "Is it bound?" for AM-side bookkeeping that must not run for a bound session:
 * the rollout re-pin, the breadcrumb capture, the stale-pin clear. Unknown
 * answers TRUE and never throws — these run on background timers with no
 * request to report to, and skipping a capture for an unbound session is
 * harmless where re-pinning a bound one is not.
 */
export function boundOrUnknown(sessionOrId, bindings = codexBindings) {
  const id = typeof sessionOrId === 'string' ? sessionOrId : sessionOrId?.id;
  try { return !!bindings.forSession(id); } catch { return true; }
}

export function codexLaunchBlock(session, bindings = codexBindings) {
  if (session.cli !== 'codex') return null;
  const binding = sharedBinding(session, bindings);
  if (binding) return null;
  // `codexSharedOnly` is set by two different writers, and they need two
  // different answers. prepareCodexMigration sets it alongside `codexMigration`
  // on a legacy session that is part-way through migrating — that one is told to
  // finish the migration, below. createCodexReference sets it alone, on an
  // imported view whose binding write failed: there is no AM-side conversation
  // to migrate and the migration URL belongs to the other flow, so telling that
  // operator to migrate sends them to a preview for a thread that was never
  // theirs. What it needs is its own import finished.
  if (session.codexSharedOnly && !session.codexMigration) {
    return {
      state: 'import-incomplete', code: 'codex-import-incomplete', threadId: null,
      previewUrl: null, applyUrl: null,
      message: 'Finish adding this shared task before opening its terminal. No standalone session was started.',
    };
  }
  if (!sharedCodexMode() && !session.codexSharedOnly) return null;
  const threadId = validThreadId(session.codexSessionId) ? session.codexSessionId : null;
  const url = `/api/sessions/${encodeURIComponent(session.id)}/codex/migration`;
  return {
    state: 'migration-required', code: 'codex-migration-required', threadId,
    previewUrl: threadId ? url : null, applyUrl: threadId ? url : null,
    message: threadId
      ? `This Codex session must be migrated to the shared server using its existing thread ${threadId}. Review GET ${url}, then apply that preview with POST ${url}. No terminal was started and no prompt was queued.`
      : 'This Codex session has no verified thread ID. Identify its existing conversation before migrating it to the shared server. No terminal was started and no prompt was queued.',
  };
}

export function assertCodexLaunchAllowed(session, bindings = codexBindings) {
  const block = codexLaunchBlock(session, bindings);
  if (block) throw new ApiError(409, block.code, block.message, {
    reason: block.state,
    details: [{ field: 'codexSessionId', message: block.threadId || 'Existing thread identity required' },
      ...(block.previewUrl ? [{ field: 'migrationPreview', message: block.previewUrl }, { field: 'migrationApply', message: block.applyUrl }] : [])],
  });
}

export function assertLegacyCodexCreationAllowed(cli) {
  if (cli === 'codex' && sharedCodexMode()) throw new ApiError(409, 'codex-shared-create-required',
    'This host uses shared Codex. Create new tasks through the shared creation API; scheduled creation of a standalone Codex terminal is disabled.');
}
