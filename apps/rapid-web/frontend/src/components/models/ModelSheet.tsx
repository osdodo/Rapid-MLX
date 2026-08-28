import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import {
  cancelDownload,
  fetchDownload,
  fetchModels,
  loadModel,
  pullModel,
  removeModel,
} from '@/api/models';
import { asApiError } from '@/api/errors';
import type { DownloadJob, ModelEntry, StatusResponse } from '@/api/types';
import { formatBytes } from '@/lib/format';
import { useStore } from '@/state/store';
import { noticeFor } from '@/state/notices';
import { percent } from '@/components/models/LifecycleBand';
import { Sheet } from '@/components/common/Sheet';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ModelSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const models = useStore((state) => state.models);
  const selected = useStore((state) => state.selectedAlias);
  const allowDownloads = useStore((state) => state.allowDownloads);
  const download = useStore((state) => state.download);
  // The STATE alone, not the job: the poll effect keys on this, and
  // subscribing to the whole job would tear it down and rebuild it on every
  // byte of progress.
  const downloadState = useStore((state) => state.download?.state ?? null);
  const setModels = useStore((state) => state.setModels);
  const setDownload = useStore((state) => state.setDownload);
  const selectAlias = useStore((state) => state.selectAlias);
  const pushNotice = useStore((state) => state.pushNotice);

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ModelEntry | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const refresh = useMemo(
    () => async (force: boolean) => {
      setLoading(true);
      setFailure(null);
      try {
        const response = await fetchModels(force);
        setModels(response.models);
        useStore.getState().setCapabilities(response.can_switch, response.allow_downloads);
      } catch (cause) {
        const error = asApiError(cause);
        setFailure(error.message);
      } finally {
        setLoading(false);
      }
    },
    [setModels],
  );

  useEffect(() => {
    if (!open) return;
    // Fetching on open, not deriving state from props.
    //
    // `force`, since the Refresh button was removed: opening the picker is a
    // deliberate act, not a poll, so it should not be served a disk scan up to
    // the server's TTL old. Without this there would be no way at all to see a
    // model pulled from the Mac a moment ago.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(true);
  }, [open, refresh]);

  // Poll the current download. Re-attaches to a job that was already running,
  // so reopening the sheet mid-download shows real progress rather than
  // nothing.
  //
  // A poll rather than a stream because trycloudflare buffers the SSE feed
  // this replaced indefinitely — see `fetchDownload` for the measurements.
  //
  // It runs in exactly two situations, and stops otherwise:
  //
  // * `null` — we do not know yet. One discovery request on open, which is
  //   what re-attaches to a pull started before this page loaded.
  // * `running` — there is progress to follow.
  //
  // A terminal job is NOT polled. The server retains the last finished job
  // indefinitely, so asking again can only ever return the same answer; the
  // old loop kept requesting once a second for the life of the sheet. Both
  // places that start a pull put a `running` job in the store, so this effect
  // re-runs and resumes on its own when the next download begins.
  useEffect(() => {
    if (!open || !allowDownloads) return;
    if (downloadState !== null && downloadState !== 'running') return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Only a completion we actually WATCHED means the disk changed. Arriving
    // to find a retained `done` from a previous session does not — and the
    // sheet's open effect has already re-read the catalog by then.
    const watching = downloadState === 'running';
    let failures = 0;

    const tick = async () => {
      let again: boolean;
      try {
        const job = await fetchDownload(controller.signal);
        if (controller.signal.aborted) return;
        failures = 0;
        setDownload(job.state === 'idle' ? null : job);
        // A finished download changes what is on disk, so the list has to be
        // re-read or the row still says "remote".
        if (job.state === 'done' && watching) void refresh(true);
        again = job.state === 'running';
      } catch {
        // A dropped request is not a reason to abandon a live download, but a
        // server that is simply gone must not be polled forever.
        failures += 1;
        again = failures < 5;
      }
      // Scheduled AFTER the response, not on an interval: a slow request must
      // not stack up a queue of overlapping polls.
      if (again && !controller.signal.aborted) timer = setTimeout(() => void tick(), 1000);
    };

    void tick();

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [open, allowDownloads, downloadState, setDownload, refresh]);

  const chatModels = useMemo(
    () =>
      models.filter((model) => {
        const term = query.trim().toLowerCase();
        return term === '' || model.alias.toLowerCase().includes(term);
      }),
    [models, query],
  );

  const choose = async (model: ModelEntry) => {
    if (model.alias === selected) {
      onClose();
      return;
    }

    if (!model.cached) {
      if (!allowDownloads) {
        pushNotice({
          tone: 'info',
          title: 'Downloads are off on this server',
          body: `Pull ${model.alias} from the Mac, then it will appear here as ready to start.`,
        });
        return;
      }
      try {
        const job = await pullModel(model.alias);
        setDownload(job);
        selectAlias(model.alias);
      } catch (cause) {
        pushNotice(noticeFor(asApiError(cause), () => void refresh(true)));
      }
      return;
    }

    selectAlias(model.alias);
    try {
      const result = await loadModel(model.alias);
      // Adopt the server's OWN account of what it is now doing, rather than
      // waiting up to 15 s for the next poll to say so. Between the two, the
      // readiness value has no serving state for the new alias and resolves to
      // "isn't running — it's already downloaded", telling the user to start
      // something that is already starting.
      useStore.getState().setStatus(
        {
          state: result.state as StatusResponse['state'],
          model: result.model,
          port: null,
          detail: null,
          can_switch: true,
        },
        false,
      );
      onClose();
    } catch (cause) {
      // Branches on error.type: busy_streaming, busy_loading and
      // switch_unavailable are three different situations with three
      // different answers, and the old page showed one alert for all of them.
      pushNotice(noticeFor(asApiError(cause)));
    }
  };

  const remove = async (model: ModelEntry) => {
    setDeleting(model.alias);
    try {
      const result = await removeModel(model.alias);
      const freed = formatBytes(result.freed_bytes);
      pushNotice({
        tone: 'info',
        title: freed ? `Deleted ${model.alias} — freed ${freed}` : `Deleted ${model.alias}`,
        body: 'You can download it again by selecting it.',
      });
      // The row still says "on disk" until the catalog is re-scanned, and the
      // server's TTL would otherwise hold that for a few seconds.
      await refresh(true);
    } catch (cause) {
      pushNotice(noticeFor(asApiError(cause), () => void refresh(true)));
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Model">
      <div className="bg-background sticky top-0 z-1 px-3.5 pt-3 pb-2">
        <label htmlFor="model-search" className="sr-only">
          Search models
        </label>
        <Input
          id="model-search"
          type="search"
          className="h-10"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 pb-3">
        {failure ? (
          <p className="text-destructive m-0 px-3.5 py-6 text-center text-sm">{failure}</p>
        ) : chatModels.length === 0 ? (
          <p className="text-muted-foreground m-0 px-3.5 py-6 text-center text-sm">
            {loading ? 'Loading…' : query ? 'No models match.' : 'No models found.'}
          </p>
        ) : (
          chatModels.map((model) => (
            <ModelRow
              key={model.alias}
              model={model}
              current={model.alias === selected}
              deleting={deleting === model.alias}
              onChoose={() => void choose(model)}
              onDelete={() => setPendingDelete(model)}
            />
          ))
        )}
      </div>

      {download ? <DownloadStrip job={download} onCancel={() => void cancelDownload()} /> : null}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete?.alias ?? ''}"?`}
        body={deleteBody(pendingDelete)}
        confirmLabel="Delete"
        destructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (pendingDelete) void remove(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </Sheet>
  );
}

function deleteBody(model: ModelEntry | null): string {
  const size = formatBytes(model?.cached_bytes);
  const freed = size ? ` Frees ${size}.` : '';
  return `Removes the weights from your Mac. You can download it again later by selecting it.${freed}`;
}

function ModelRow({
  model,
  current,
  deleting,
  onChoose,
  onDelete,
}: {
  model: ModelEntry;
  current: boolean;
  deleting: boolean;
  onChoose(): void;
  onDelete(): void;
}) {
  const size = formatBytes(model.cached ? model.cached_bytes : model.size_bytes);

  return (
    // A div, not the button it used to be: the trash is a second control, and
    // a button inside a button is invalid and unclickable in Safari.
    <div
      className={cn(
        'group hover:bg-accent flex w-full items-center gap-1 rounded-md pr-1.5 pl-3',
        current && 'bg-accent',
      )}
    >
      {/* `text-left` belongs on the button, NOT on the row around it: a
          <button> gets `text-align: center` from the UA stylesheet, which
          beats an inherited value. Set on the row only, the alias centred
          itself while the metadata line below — a flex container, so
          unaffected — stayed left, and the list read as ragged. */}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 py-2.5 text-left outline-none"
        onClick={onChoose}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-sm font-medium [overflow-wrap:anywhere]">{model.alias}</span>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            {size ?? 'size unknown'}
            {model.reasoning_parser ? <Badge variant="secondary">thinks</Badge> : null}
            {model.tool_call_parser ? <Badge variant="secondary">tools</Badge> : null}
          </span>
        </span>
        <Badge variant={model.cached ? 'default' : 'outline'} className="shrink-0 rounded-full">
          {model.cached ? 'on disk' : 'remote'}
        </Badge>
      </button>

      {/* A fixed slot, always present, holding the trash only where there is
          something to delete. Rendering the button conditionally instead let
          the row's width change: an uncached row put its badge 36px further
          right than a cached one, and hovering a cached row shifted its badge
          as the button faded in. The badges have to line up in one column
          down the list or it reads as ragged. */}
      <span className="flex size-9 shrink-0 items-center justify-center">
        {model.cached ? (
          <Button
            variant="ghost"
            size="icon"
            // Revealed on hover on a pointer device, always shown on touch,
            // where there is no hover and it would be unreachable — same rule
            // as the conversation row's controls.
            className="text-muted-foreground size-9 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 [&_svg:not([class*=size-])]:size-4 [@media(hover:none)]:opacity-100"
            onClick={onDelete}
            disabled={deleting}
            aria-label={`Delete ${model.alias}`}
            title="Delete"
          >
            <Trash2 />
          </Button>
        ) : null}
      </span>
    </div>
  );
}

function DownloadStrip({ job, onCancel }: { job: DownloadJob; onCancel(): void }) {
  const failed = job.state === 'failed';
  const done = job.done_bytes ?? 0;
  const total = job.total_bytes ?? null;
  const fraction = total && total > 0 ? done / total : null;

  const label =
    job.state === 'failed'
      ? 'failed'
      : job.state === 'cancelled'
        ? 'cancelled'
        : job.state === 'done'
          ? 'done'
          : fraction !== null
            ? `${percent(fraction)} of ${formatBytes(total) ?? ''}`
            : (formatBytes(done) ?? 'starting…');

  return (
    <div
      className={cn(
        'bg-muted sticky bottom-0 border-t px-3.5 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)]',
        failed && 'border-destructive/40',
      )}
    >
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-medium">{job.alias ?? 'Downloading'}</span>
        <span
          className={cn(
            'font-mono text-xs',
            failed ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
        {job.state === 'running' ? (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <div className="bg-background h-[3px] overflow-hidden rounded-full">
        <div
          className={cn(
            'h-full transition-[width] duration-300',
            failed ? 'bg-destructive' : 'bg-primary',
          )}
          style={{
            width:
              job.state === 'done'
                ? '100%'
                : job.state === 'cancelled'
                  ? '0%'
                  : fraction !== null
                    ? percent(fraction)
                    : '0%',
          }}
        />
      </div>
      {job.detail ? (
        <p className="text-muted-foreground m-0 mt-1.5 text-xs">{job.detail}</p>
      ) : null}
    </div>
  );
}
