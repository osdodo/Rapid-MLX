/**
 * The single lifecycle value for the whole page.
 *
 * A direct port of apps/rapid-mac/Sources/Rapid/UI/ModelReadiness.swift. The
 * point of it is not the enum but the fact that ONE value derives the
 * readiness banner, the composer placeholder, the send tooltip, the empty
 * state and the accessibility announcement — so those five can never disagree.
 * The old page had no such value: the model chip carried an ad-hoc class name,
 * the empty state carried a separately-patched subtitle, and every failure
 * arrived as `window.alert`.
 *
 * Pure and React-free, so the whole truth table is testable without a DOM.
 *
 * Two deliberate deviations from the Swift original:
 *
 *   * `engineMissing` is gone. There is no local binary here; a web client
 *     that cannot reach an engine is a network problem, not a setup problem.
 *   * `serverUnreachable` is new, and is the state the old page most badly
 *     lacked. On a phone behind a tunnel the connection dropping — the Mac
 *     slept, the tunnel died, the radio dropped — is the single most likely
 *     failure, and index.html:1449-1453 collapsed it into a red "offline"
 *     chip with no explanation and no reassurance.
 */

export type ReadinessAction =
  /**
   * Deliberately NOT rendered as a button.
   *
   * The model chip sits in the header and already says "Choose a model", so
   * a second control with the same words is a duplicate action. The case
   * exists so the copy and the live-region announcement can still name the
   * step. Same reasoning as ModelReadiness.swift:88-99.
   */
  | { kind: 'chooseModel' }
  | { kind: 'download'; alias: string }
  | { kind: 'start'; alias: string }
  | { kind: 'retry'; alias: string }
  | { kind: 'reconnect' };

export type ModelReadiness =
  | { kind: 'serverUnreachable'; consecutiveFailures: number }
  /**
   * Nothing chosen. `canSwitch` is false in --attach mode, where the engine
   * belongs to whoever started it — and the two cases need OPPOSITE copy:
   * one points at the model picker, the other has to say the picker will not
   * help. Carrying it on the state rather than patching the string at the
   * call site keeps every surface agreeing, which is the point of this type.
   */
  | { kind: 'noModel'; canSwitch: boolean }
  | { kind: 'needsDownload'; alias: string; sizeText: string | null }
  | { kind: 'needsStart'; alias: string }
  | { kind: 'unknownModel'; alias: string }
  | {
      kind: 'downloading';
      alias: string;
      detail: string | null;
      fraction: number | null;
    }
  | { kind: 'starting'; alias: string; detail: string | null }
  | { kind: 'ready'; alias: string }
  | {
      kind: 'failed';
      alias: string | null;
      message: string;
      action: ReadinessAction | null;
    };

/**
 * What is known about an alias's weights.
 *
 * Four states, not a nullable boolean. Collapsing "we do not know" into
 * `null` is precisely the defect ModelReadiness.swift:191-200 records: an
 * alias the catalog had never heard of was told "It's already downloaded",
 * contradicting the picker's own unknown-model marker in the same row.
 */
export type CacheState =
  /** The catalog says the weights are complete on disk. */
  | 'onDisk'
  /** The catalog lists it and says the weights are absent or partial. */
  | 'notOnDisk'
  /** The catalog has not been fetched yet. Says nothing either way. */
  | 'catalogPending'
  /** The catalog loaded and does not list this alias. Says nothing either way. */
  | 'notInCatalog';

export type StatusRole = 'idle' | 'working' | 'ready' | 'error';

// --------------------------------------------------------------- resolution

/**
 * Placeholder names the engine reports that must never be interpolated into
 * copy as if they were models. Without this filter the page renders
 * "Couldn't start ." or "Starting Loading" — the defect
 * ModelDisplayName (RapidTheme.swift:809) exists to prevent.
 */
const PLACEHOLDERS = new Set([
  '',
  'loading',
  'starting',
  'warming up',
  'downloading',
  'unknown',
  'none',
  'null',
]);

/** A name we are willing to show a user, or null. */
export function displayable(alias: string | null | undefined): string | null {
  if (!alias) return null;
  const trimmed = alias.trim();
  return PLACEHOLDERS.has(trimmed.toLowerCase()) ? null : trimmed;
}

/**
 * Permissive rule for a non-send-enabling serve state (`starting`): may the
 * in-flight start describe the current pick?
 *
 * Port of ModelReadiness.swift:622-645. The asymmetry in the last two cases
 * is the point: a real serving model with an unsynced selection is the launch
 * frame where the picker lags the auto-started model, and showing the real
 * name is right. But a PLACEHOLDER start while a real model B is selected
 * must not claim "Starting B" — that would suppress B's own Start button for
 * a start we cannot prove is B's.
 */
export function serveStateSpeaksForSelection(
  serving: string | null,
  selected: string | null,
): boolean {
  const s = displayable(serving);
  const p = displayable(selected);
  if (s !== null && p !== null) return s === p;
  if (s !== null && p === null) return true;
  if (s === null && p === null) return true;
  return false;
}

/**
 * Strict rule for the send-enabling `ready` state.
 *
 * `ready` may describe the selection ONLY when a real serving model equals a
 * real selected model. If a different model is serving, or nothing is really
 * selected yet, `ready` must not win — resolving the selection's own state
 * keeps Send gated rather than enabling it against an alias the send path is
 * not holding. ModelReadiness.swift:647-658.
 */
export function readyDescribesSelection(serving: string | null, selected: string | null): boolean {
  const s = displayable(serving);
  const p = displayable(selected);
  return s !== null && p !== null && s === p;
}

/**
 * Is a recorded failure still the CURRENT selection's problem?
 *
 * Port of ModelReadiness.swift:600-620. The asymmetry in the last two cases
 * is deliberate:
 *
 *   * Nothing chosen — show it. It is the most useful thing on screen and
 *     there is no other model to describe instead.
 *   * A model is chosen and the failure names a model — show it only when
 *     they are the same model.
 *   * A model is chosen and the failure names nothing — SUPPRESS it. We
 *     cannot prove the failure is about this model, and blaming the user's
 *     fresh pick for an unattributable error is the worse of the two
 *     mistakes. The selection's own state is shown instead, which is always
 *     true.
 */
export function failureApplies(failedAlias: string | null, selectedAlias: string | null): boolean {
  if (selectedAlias === null) return true;
  if (failedAlias === null) return false;
  return failedAlias === selectedAlias;
}

export interface ResolveInput {
  /** Latest `/api/status`, or null if it has never succeeded. */
  status: { state: string; model: string | null; detail: string | null } | null;
  /** Consecutive `/api/status` failures. */
  statusFailures: number;
  /** What the user last picked, falling back to what the server is serving. */
  selectedAlias: string | null;
  cacheState: CacheState;
  /** Formatted download size for `needsDownload`, from the catalog's byte
   *  count — never parsed out of the alias name. */
  sizeText: string | null;
  /** A running download for the selected alias, if any. */
  download: {
    alias: string | null;
    fraction: number | null;
    detail: string | null;
  } | null;
  /** The last turn-level failure, with the alias it was attributed to. */
  turnError: { message: string; alias: string | null } | null;
  /** False in --attach mode. Changes what `noModel` is allowed to promise. */
  canSwitch: boolean;
}

/**
 * Two consecutive failures before declaring the server unreachable.
 *
 * One miss is a phone radio dropping a packet or a tunnel hiccuping, and the
 * old page turned the chip red for exactly that (index.html:1449-1453). Two
 * misses across the adaptive poll interval is a real outage.
 */
const UNREACHABLE_THRESHOLD = 2;

/**
 * Resolve the one readiness value.
 *
 * THE ORDER IS THE CONTRACT. Each step is justified against the one below it,
 * and reordering them changes behaviour in ways that are not obvious from the
 * cases alone.
 */
export function resolveReadiness(input: ResolveInput): ModelReadiness {
  const { status, statusFailures, cacheState, sizeText, download, turnError } = input;
  const selected = displayable(input.selectedAlias);

  // 1. Reachability first. Nothing below can be trusted if the last few
  //    status polls never landed — a stale "ready" would enable Send against
  //    a server that is gone.
  if (statusFailures >= UNREACHABLE_THRESHOLD) {
    return { kind: 'serverUnreachable', consecutiveFailures: statusFailures };
  }

  // 2. Work in flight beats a stale failure. The user pressed Retry or
  //    Download and it IS working; showing them the old error would be a lie
  //    about the present.
  if (download && (download.alias === null || download.alias === selected)) {
    return {
      kind: 'downloading',
      alias: displayable(download.alias) ?? selected ?? 'your model',
      detail: download.detail,
      fraction: download.fraction,
    };
  }

  if (
    status?.state === 'starting' &&
    serveStateSpeaksForSelection(status.model, input.selectedAlias)
  ) {
    // Fall back through both names rather than echoing a raw placeholder,
    // which would render "Starting Loading" or "Starting " with a trailing
    // space.
    const name = displayable(status.model) ?? selected ?? 'your local model';
    return { kind: 'starting', alias: name, detail: status.detail };
  }

  // 3. Ready, under the STRICT selection rule. The only send-enabling state.
  if (status?.state === 'ready' && readyDescribesSelection(status.model, input.selectedAlias)) {
    return { kind: 'ready', alias: displayable(status.model) as string };
  }

  // 4. The engine itself failed. Outranks a turn error: if the child is down,
  //    that is why the turn failed, and it is the more actionable statement.
  if (status?.state === 'failed') {
    const failedAlias = displayable(status.model) ?? selected;
    return {
      kind: 'failed',
      alias: failedAlias,
      message: status.detail ?? 'The engine stopped unexpectedly.',
      action: failedAlias ? { kind: 'retry', alias: failedAlias } : { kind: 'chooseModel' },
    };
  }

  // 5. A turn failed, and the failure still belongs to this selection.
  if (turnError && failureApplies(turnError.alias, selected)) {
    const failedAlias = turnError.alias ?? selected;
    return {
      kind: 'failed',
      alias: failedAlias,
      message: turnError.message,
      action: failedAlias ? { kind: 'retry', alias: failedAlias } : null,
    };
  }

  // 6. Nothing chosen.
  if (selected === null) return { kind: 'noModel', canSwitch: input.canSwitch };

  // 7-9. A real alias is chosen and nothing is serving it. What we tell the
  //      user depends entirely on what we actually KNOW about the weights,
  //      which is why cacheState has four values and not two.
  switch (cacheState) {
    case 'notOnDisk':
      return { kind: 'needsDownload', alias: selected, sizeText };
    case 'notInCatalog':
      return { kind: 'unknownModel', alias: selected };
    case 'onDisk':
    case 'catalogPending':
      return { kind: 'needsStart', alias: selected };
  }
}

// ------------------------------------------------------------------ derived

/**
 * The ONLY send-enabling predicate.
 *
 * A gated send must not consume the draft — see the composer. The trade is
 * deliberate: one extra tap on the banner's action buys the user a visible,
 * cancellable, explicable startup instead of a multi-gigabyte download behind
 * an indeterminate spinner.
 */
export function sendAllowed(r: ModelReadiness): boolean {
  return r.kind === 'ready';
}

export function statusRole(r: ModelReadiness): StatusRole {
  switch (r.kind) {
    case 'ready':
      return 'ready';
    case 'downloading':
    case 'starting':
      return 'working';
    case 'failed':
    case 'serverUnreachable':
      return 'error';
    default:
      return 'idle';
  }
}

/** True while the model is doing something. Drives the pulsing status dot. */
export function isWorking(r: ModelReadiness): boolean {
  return r.kind === 'downloading' || r.kind === 'starting';
}

export function readinessAlias(r: ModelReadiness): string | null {
  switch (r.kind) {
    case 'needsDownload':
    case 'needsStart':
    case 'unknownModel':
    case 'downloading':
    case 'starting':
    case 'ready':
      return r.alias;
    case 'failed':
      return r.alias;
    default:
      return null;
  }
}

/** Determinate progress, or null. Never synthesised — see LifecycleBand. */
export function progressFraction(r: ModelReadiness): number | null {
  return r.kind === 'downloading' ? r.fraction : null;
}

export function readinessAction(r: ModelReadiness): ReadinessAction | null {
  switch (r.kind) {
    case 'serverUnreachable':
      return { kind: 'reconnect' };
    case 'noModel':
      // No action at all when we cannot switch: an action the user cannot
      // take is worse than none, and `chooseModel` is not renderable anyway.
      return r.canSwitch ? { kind: 'chooseModel' } : null;
    case 'needsDownload':
      return { kind: 'download', alias: r.alias };
    case 'needsStart':
    case 'unknownModel':
      return { kind: 'start', alias: r.alias };
    case 'failed':
      return r.action;
    case 'downloading':
    case 'starting':
    case 'ready':
      return null;
  }
}

/**
 * Is this action worth rendering as a button?
 *
 * `chooseModel` is not: the model chip is a few pixels away and already says
 * the same thing.
 */
export function actionIsRenderable(action: ReadinessAction | null): boolean {
  return action !== null && action.kind !== 'chooseModel';
}

export function actionTitle(action: ReadinessAction): string {
  switch (action.kind) {
    case 'chooseModel':
      return 'Choose a model';
    case 'download':
      return 'Download';
    case 'start':
      return 'Start';
    case 'retry':
      return 'Retry';
    case 'reconnect':
      return 'Reconnect';
  }
}

// --------------------------------------------------------------------- copy
//
// ONE vocabulary, used by every surface: you CHOOSE a model, DOWNLOAD it if
// needed, START it, and then it is READY. No surface may invent a fifth verb.
// Ported string-for-string from ModelReadiness.swift:454-591 except where a
// comment marks a web-specific change.

/** Short status line — the bold half of the readiness banner. */
export function headline(r: ModelReadiness): string {
  switch (r.kind) {
    case 'serverUnreachable':
      return "Can't reach your Mac";
    case 'noModel':
      return 'No model chosen';
    case 'needsDownload':
      return `${r.alias} isn't downloaded yet`;
    case 'needsStart':
    case 'unknownModel':
      return `${r.alias} isn't running`;
    case 'downloading':
      return `Downloading ${r.alias}`;
    case 'starting':
      return `Starting ${r.alias}`;
    case 'ready':
      return `Ready — ${r.alias}`;
    case 'failed':
      return r.alias ? `Couldn't start ${r.alias}` : 'Something went wrong';
  }
}

/** The explanation under the headline — the "say why sending is unavailable"
 *  half of the contract. */
export function detail(r: ModelReadiness): string | null {
  switch (r.kind) {
    case 'serverUnreachable':
      return 'Rapid-MLX is probably still running. This page will keep trying.';
    case 'noModel':
      // In --attach mode the picker is not the answer and saying so is the
      // whole job: the previous copy sent the user to a control that was
      // disabled, with no way to find out why.
      return r.canSwitch
        ? 'Choose a model in the sidebar to get started.'
        : // Terser than the sidebar's version on purpose. The sidebar already
          // explains the ownership in full and is on screen at the same time;
          // saying it twice, verbatim, in one viewport reads as a stutter.
          'The attached engine has no model loaded.';
    case 'needsDownload':
      return r.sizeText
        ? `It downloads once (${r.sizeText}), then starts in seconds.`
        : 'It downloads once, then starts in seconds.';
    case 'needsStart':
      return "It's already downloaded — starting takes a few seconds.";
    case 'unknownModel':
      // Deliberately promises nothing. We cannot say it is downloaded (the
      // old copy did), we cannot quote a size, and we must not promise a
      // download either. State the one thing that is true.
      return "Rapid doesn't know this one, so it can't say whether it's already on your Mac.";
    case 'downloading':
      return r.detail ?? 'Starting the download…';
    case 'starting':
      return r.detail ?? 'Loading the model into memory…';
    case 'ready':
      return null;
    case 'failed':
      return r.message;
  }
}

/**
 * Placeholder for the compose field.
 *
 * Terse: it names the blocking step rather than repeating the banner's full
 * sentence, so the two are complementary instead of redundant. On a phone
 * this is often the ONLY affordance visible, since there is no tooltip.
 */
export function composerPlaceholder(r: ModelReadiness): string {
  switch (r.kind) {
    case 'serverUnreachable':
      return 'Reconnecting…';
    case 'noModel':
      return r.canSwitch ? 'Choose a model first' : 'No model loaded on the engine';
    case 'needsDownload':
      return `Download ${r.alias} first`;
    case 'needsStart':
    case 'unknownModel':
      return `Start ${r.alias} first`;
    case 'downloading':
      return `Downloading ${r.alias}…`;
    case 'starting':
      return `Starting ${r.alias}…`;
    case 'ready':
      // Web deviation: matches the existing page's placeholder rather than
      // the Mac app's "Send a message…".
      return 'Message';
    case 'failed':
      return 'Retry to continue';
  }
}

/**
 * Send-button tooltip.
 *
 * Doubles as the live-region announcement when a gated send is attempted, so
 * both channels say the same thing. On a phone there is no hover, so the
 * announcement is the only channel that fires.
 */
export function sendTooltip(r: ModelReadiness): string {
  switch (r.kind) {
    case 'serverUnreachable':
      return "Can't reach your Mac right now.";
    case 'noModel':
      return r.canSwitch
        ? 'Choose a model before sending.'
        : 'The attached engine has no model loaded.';
    case 'needsDownload':
      return `Download ${r.alias} before sending.`;
    case 'needsStart':
    case 'unknownModel':
      return `Start ${r.alias} before sending.`;
    case 'downloading':
      return `${r.alias} is still downloading.`;
    case 'starting':
      return `${r.alias} is still starting.`;
    case 'ready':
      return 'Send';
    case 'failed':
      return r.alias ? `${r.alias} isn't running — retry to continue.` : 'Not ready to send yet.';
  }
}

/** The line under "Ask anything" on the empty chat. */
export function emptyStateSubtitle(r: ModelReadiness): string {
  switch (r.kind) {
    case 'serverUnreachable':
      return 'Reconnecting to your Mac…';
    case 'noModel':
      return r.canSwitch ? 'Choose a model to start' : 'No model loaded';
    case 'needsDownload':
      return `Download ${r.alias} to start`;
    case 'needsStart':
    case 'unknownModel':
      return `Start ${r.alias} to begin`;
    case 'downloading':
      return 'Downloading your local model…';
    case 'starting':
      return 'Preparing your local model…';
    case 'ready':
      return `Chatting with ${r.alias}`;
    case 'failed':
      return r.alias ? `Couldn't start ${r.alias}` : 'Something went wrong';
  }
}

/**
 * The quieter third line on the empty state. Null whenever the subtitle
 * already says everything — an empty state must not stack three sentences
 * that mean the same thing.
 */
export function emptyStateHint(r: ModelReadiness): string | null {
  switch (r.kind) {
    case 'needsDownload':
      return r.sizeText ? `First download is about ${r.sizeText}.` : null;
    case 'downloading':
      return r.detail;
    case 'failed':
      return r.message;
    default:
      return null;
  }
}

/** Composed announcement for the readiness banner. */
export function accessibilityLabel(r: ModelReadiness): string {
  const parts = [headline(r)];
  const d = detail(r);
  if (d) parts.push(d);
  return parts.join(', ');
}
