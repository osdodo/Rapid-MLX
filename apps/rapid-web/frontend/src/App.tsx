import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { requestJson, requestPublic, setToken } from '@/api/client';
import { asApiError } from '@/api/errors';
import { fetchStatus, loadModel, pullModel } from '@/api/models';
import type { AuthResponse, ConfigResponse } from '@/api/types';
import { Gate } from '@/components/common/Gate';
import { consumeFragmentToken, rememberToken, storedToken } from '@/auth/token';
import { branchPosition, editAndResend, retry, send, stopTurn, switchBranch } from '@/chat/turn';
import { deleteConfirmationTitle, deletionImpact, subtree } from '@/chat/MessageTree';
import { formatBytes } from '@/lib/format';
import { probeMathMLSupport } from '@/markdown/math';
import { LifecycleBand } from '@/components/models/LifecycleBand';
import {
  composerPlaceholder,
  emptyStateHint,
  emptyStateSubtitle,
  headline,
  resolveReadiness,
  sendAllowed,
  sendTooltip,
  type CacheState,
  type ReadinessAction,
} from '@/readiness/ModelReadiness';
import { useActiveConversation, useActivePath, useStore } from '@/state/store';
import { Composer } from '@/components/chat/Composer';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { ChatBar } from '@/components/chat/ChatBar';
import { ModelButton } from '@/components/models/ModelButton';
import { Sidebar, SidebarDrawer, useWideLayout } from '@/components/conversations/Sidebar';
import { SearchPalette, useSearchShortcut } from '@/components/conversations/SearchPalette';
import { MessageRow } from '@/components/chat/MessageRow';
import { LiveRegion, Transcript } from '@/components/chat/Transcript';
import { ModelSheet } from '@/components/models/ModelSheet';
import { NoticeStack } from '@/components/common/Notice';
import { noticeFor } from '@/state/notices';
import { SettingsSheet } from '@/components/common/SettingsSheet';

type Phase = { kind: 'booting' } | { kind: 'gate'; initial: string } | { kind: 'ready' };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' });

  useEffect(() => {
    // The fragment is consumed FIRST, before anything can navigate, so the
    // token is out of the address bar as early as possible.
    const fromFragment = consumeFragmentToken();

    void (async () => {
      try {
        const config = await requestPublic<ConfigResponse>('/api/config');
        if (!config.auth_required) {
          setToken(null);
          const capabilities = await probeCapabilities();
          applyCapabilities(capabilities);
          setPhase({ kind: 'ready' });
          return;
        }
      } catch {
        // The probe failed. Fall through to the gate rather than assuming
        // auth is off — failing toward the login screen is the safe
        // direction, and a wrong guess the other way silently sends
        // unauthenticated requests.
      }
      setPhase({ kind: 'gate', initial: fromFragment ?? storedToken() ?? '' });
    })();
  }, []);

  // A token from the fragment or from a previous visit: try it rather than
  // making the user press Enter on a field that is already filled in.
  useEffect(() => {
    if (phase.kind !== 'gate' || phase.initial === '') return;
    setToken(phase.initial);
    void probeCapabilities()
      .then((capabilities) => {
        // Persisted only AFTER the server accepts it — and it MUST be
        // persisted here, not only on the manual path. A fragment token is
        // stripped from the URL immediately, so if this path validates it
        // without storing it, the very next reload has nothing to present and
        // the user is asked to log in again despite having just scanned the
        // QR code. Caught end-to-end; no unit test sees a reload.
        rememberToken(phase.initial);
        applyCapabilities(capabilities);
        setPhase({ kind: 'ready' });
      })
      .catch(() => {
        // Rejected or unreachable. The gate is already showing, prefilled.
        setToken(null);
      });
    // Intentionally runs once per gate entry, not per keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind]);

  if (phase.kind === 'booting') return <div className="bg-background h-dvh" />;

  if (phase.kind === 'gate') {
    return (
      <Gate
        initialToken={phase.initial}
        onAuthenticated={(response) => {
          applyCapabilities(response);
          setPhase({ kind: 'ready' });
        }}
      />
    );
  }

  return <Chat />;
}

function probeCapabilities(): Promise<AuthResponse> {
  return requestJson<AuthResponse>('/api/auth', { method: 'POST', body: {} });
}

function applyCapabilities(response: AuthResponse): void {
  useStore.getState().setCapabilities(response.can_switch, response.allow_downloads);
}

function Chat() {
  const path = useActivePath();
  const conversation = useActiveConversation();
  const settings = useStore((state) => state.settings);
  const status = useStore((state) => state.status);
  const statusFailures = useStore((state) => state.statusFailures);
  const selectedAlias = useStore((state) => state.selectedAlias);
  const models = useStore((state) => state.models);
  const catalogLoaded = useStore((state) => state.catalogLoaded);
  const download = useStore((state) => state.download);
  const canSwitch = useStore((state) => state.canSwitch);
  const attentionToken = useStore((state) => state.attentionToken);
  const pushNotice = useStore((state) => state.pushNotice);

  const [sheet, setSheet] = useState<'none' | 'models' | 'settings'>('none');
  const wide = useWideLayout();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    impact: number;
  } | null>(null);
  // Derived, not tracked: a turn that fails or is aborted cannot leave the
  // composer stuck in "stop", and there is no cascading render.
  const streaming = path.some((node) => node.status === 'streaming');
  const [revision, setRevision] = useState(0);

  useThemeAttribute(settings.theme);
  useMathProbe();
  useStatusPolling();

  // A commit inside the streaming store does not change the app store, so the
  // transcript needs its own signal to re-run the scroll-follow effect.
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setRevision((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [streaming]);

  // Bumping a counter to re-run the scroll effect, not deriving state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setRevision((value) => value + 1), [path.length]);

  const cacheState: CacheState = useMemo(() => {
    if (!catalogLoaded) return 'catalogPending';
    if (selectedAlias === null) return 'catalogPending';
    const entry = models.find((model) => model.alias === selectedAlias);
    if (!entry) return 'notInCatalog';
    return entry.cached ? 'onDisk' : 'notOnDisk';
  }, [catalogLoaded, models, selectedAlias]);

  const readiness = useMemo(
    () =>
      resolveReadiness({
        status,
        statusFailures,
        selectedAlias,
        cacheState,
        sizeText: sizeTextFor(selectedAlias, models),
        download:
          download && download.state === 'running'
            ? {
                alias: download.alias ?? null,
                fraction:
                  download.total_bytes && download.total_bytes > 0
                    ? (download.done_bytes ?? 0) / download.total_bytes
                    : null,
                detail: download.detail ?? null,
              }
            : null,
        turnError: lastFailure(path),
        canSwitch,
      }),
    [status, statusFailures, selectedAlias, cacheState, models, download, path, canSwitch],
  );

  const canSend = sendAllowed(readiness) && !streaming;

  const onAction = useCallback(
    (action: ReadinessAction) => {
      void (async () => {
        try {
          switch (action.kind) {
            case 'download':
              useStore.getState().setDownload(await pullModel(action.alias));
              break;
            case 'start':
            case 'retry':
              await loadModel(action.alias);
              break;
            case 'reconnect':
              await fetchStatus();
              break;
            case 'chooseModel':
              setSheet('models');
              break;
          }
        } catch (cause) {
          pushNotice(noticeFor(asApiError(cause)));
        }
      })();
    },
    [pushNotice],
  );

  const runSend = useCallback((text: string) => {
    send(text);
  }, []);

  const newChat = useCallback(() => useStore.getState().createConversation(), []);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  useSearchShortcut(openSearch);

  // One instance, handed to whichever shell is on screen. Building it here
  // rather than twice keeps the two paths from drifting.
  const modelSelector = (
    <ModelButton
      readiness={readiness}
      alias={selectedAlias}
      canSwitch={canSwitch}
      onClick={() => setSheet('models')}
    />
  );

  return (
    <div className="relative flex h-dvh">
      {wide ? (
        <Sidebar
          header={modelSelector}
          onNewChat={newChat}
          onOpenSettings={() => setSheet('settings')}
          onSearch={openSearch}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsed((value) => !value)}
        />
      ) : (
        <SidebarDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          header={modelSelector}
          onNewChat={newChat}
          onOpenSettings={() => setSheet('settings')}
          onSearch={openSearch}
        />
      )}

      <div className="relative flex h-dvh min-w-0 flex-1 flex-col">
        <ChatBar
          title={conversationTitle(conversation)}
          onOpenSidebar={
            wide
              ? railCollapsed
                ? () => setRailCollapsed(false)
                : null
              : () => setDrawerOpen(true)
          }
          onNewChat={newChat}
        />

        <NoticeStack />

        <Transcript revision={revision} streaming={streaming}>
          {path.length === 0 ? (
            <EmptyState readiness={readiness} />
          ) : (
            path.map((node) => (
              <MessageRow
                key={node.id}
                node={node}
                mathRendering={settings.mathRendering}
                branch={conversation ? branchPosition(node.id, conversation.nodes) : null}
                onBranch={(direction) => switchBranch(node.id, direction)}
                onRetry={() => retry(node.id)}
                onEdit={(text) => editAndResend(node.id, text)}
                onDelete={() =>
                  setPendingDelete({
                    id: node.id,
                    impact: conversation ? deletionImpact(node.id, conversation.nodes) : 1,
                  })
                }
                busy={streaming}
              />
            ))
          )}
        </Transcript>

        <LifecycleBand readiness={readiness} attentionToken={attentionToken} onAction={onAction} />

        <Composer
          placeholder={composerPlaceholder(readiness)}
          sendTooltip={sendTooltip(readiness)}
          canSend={canSend}
          streaming={streaming}
          onSend={runSend}
          onStop={stopTurn}
          onBlocked={() => useStore.getState().flagBlockedSend()}
        />

        <LiveRegion message={headline(readiness)} />
      </div>

      <SearchPalette open={searchOpen} onOpenChange={setSearchOpen} onNewChat={newChat} />

      <ModelSheet open={sheet === 'models'} onClose={() => setSheet('none')} />
      <SettingsSheet
        open={sheet === 'settings'}
        onClose={() => setSheet('none')}
        engineInfo={engineInfoOf(status)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={deleteConfirmationTitle(pendingDelete?.impact ?? 1)}
        body={
          (pendingDelete?.impact ?? 1) > 1
            ? 'Alternatives below this point go with it, including any that are not on screen.'
            : undefined
        }
        confirmLabel="Delete"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete && conversation) {
            useStore.getState().removeSubtree(subtree(pendingDelete.id, conversation.nodes));
          }
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

function EmptyState({ readiness }: { readiness: Parameters<typeof emptyStateSubtitle>[0] }) {
  const hint = emptyStateHint(readiness);
  return (
    // pb-[6%] centres optically: a text block on the exact midpoint reads as
    // sitting slightly low.
    <div className="flex flex-1 flex-col items-center justify-center gap-2 pb-[6%] text-center">
      <h1 className="m-0 text-3xl font-semibold tracking-tight">Ask anything</h1>
      <p className="text-muted-foreground m-0 text-sm">{emptyStateSubtitle(readiness)}</p>
      {hint ? <p className="text-muted-foreground m-0 max-w-[34ch] text-xs">{hint}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------- hooks

/** Reflect the theme choice onto the document, for tokens.css to pick up. */
function useThemeAttribute(theme: 'auto' | 'light' | 'dark') {
  useEffect(() => {
    if (theme === 'auto') {
      // REMOVED, not set to "auto": tokens.css keys the media query on
      // `:root:not([data-theme])`, so an attribute of any value would pin
      // the palette to light.
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [theme]);
}

/**
 * Fall back to source rendering when the browser cannot lay out MathML.
 *
 * An old Android WebView parses MathML and then flattens a fraction into
 * "12" — not a crash, but silently wrong output that reads as the model's
 * fault. Probed once, and only ever downgrades: a user who chose `source`
 * explicitly must not have it switched back.
 */
function useMathProbe() {
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current) return;
    probed.current = true;
    if (useStore.getState().settings.mathRendering !== 'mathml') return;
    if (!probeMathMLSupport()) useStore.getState().updateSettings({ mathRendering: 'source' });
  }, []);
}

/**
 * Poll `/api/status`.
 *
 * Adaptive: fast while the engine is starting, because that is when the user
 * is waiting and watching; slow once it is settled, because a phone on a
 * cellular radio pays for every request in battery.
 */
function useStatusPolling() {
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      try {
        const snapshot = await fetchStatus();
        if (cancelled) return;
        useStore.getState().setStatus(snapshot, false);
        timer = setTimeout(tick, snapshot.state === 'starting' ? 2000 : 15000);
      } catch {
        if (cancelled) return;
        useStore.getState().setStatus(null, true);
        timer = setTimeout(tick, 5000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
}

// ----------------------------------------------------------------- helpers

function sizeTextFor(
  alias: string | null,
  models: ReturnType<typeof useStore.getState>['models'],
): string | null {
  if (alias === null) return null;
  const entry = models.find((model) => model.alias === alias);
  if (!entry) return null;
  // From the catalog's byte count, never parsed out of the alias name — the
  // Mac app's parser sizes `embeddinggemma-300m-6bit` to zero for exactly
  // that reason.
  return formatBytes(entry.size_bytes);
}

function lastFailure(path: ReturnType<typeof useActivePath>) {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const node = path[index];
    if (node?.status !== 'failed' || !node.error) continue;
    return { message: node.error.message, alias: node.model ?? null };
  }
  return null;
}

/** The chat bar's title. Falls back rather than showing an empty strip. */
function conversationTitle(conversation: { title: string } | null): string {
  if (!conversation) return 'New chat';
  return conversation.title.trim() === '' ? 'New chat' : conversation.title;
}

function engineInfoOf(status: ReturnType<typeof useStore.getState>['status']): string {
  if (!status) return '—';
  const parts = [status.model ?? 'no model', status.state];
  if (status.port) parts.push(`port ${status.port}`);
  return parts.join(' · ');
}
