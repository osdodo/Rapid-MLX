import { useEffect, useMemo, useRef, useState } from 'react';
import { cancelDownload, fetchModels, loadModel, pullModel, watchDownloads } from '../api/models';
import { asApiError } from '../api/errors';
import type { DownloadJob, ModelEntry, StatusResponse } from '../api/types';
import { formatBytes } from '../lib/format';
import { useStore } from '../state/store';
import { noticeFor } from './notices';
import { percent } from '../readiness/LifecycleBand';
import { Sheet } from './Sheet';
import { cn } from '../lib/cn';
import { Button } from './primitives/Button';

export function ModelSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const models = useStore((state) => state.models);
  const selected = useStore((state) => state.selectedAlias);
  const allowDownloads = useStore((state) => state.allowDownloads);
  const download = useStore((state) => state.download);
  const setModels = useStore((state) => state.setModels);
  const setDownload = useStore((state) => state.setDownload);
  const selectAlias = useStore((state) => state.selectAlias);
  const pushNotice = useStore((state) => state.pushNotice);

  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const watching = useRef<AbortController | null>(null);

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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh(false);
  }, [open, refresh]);

  // Re-attach to a download that may already be running. The server keeps the
  // feed open after a job finishes (app.py:539-550), so a client connecting
  // late still sees the current state rather than nothing.
  useEffect(() => {
    if (!open || !allowDownloads || watching.current) return;

    const controller = new AbortController();
    watching.current = controller;

    void (async () => {
      try {
        for await (const job of watchDownloads(controller.signal)) {
          setDownload(job.state === 'idle' ? null : job);
          // A finished download changes what is on disk, so the list has to
          // be re-read or the row still says "remote".
          if (job.state === 'done') void refresh(true);
        }
      } catch {
        // Aborted, or the connection dropped. Either way the feed is over and
        // the strip keeps whatever it last showed.
      } finally {
        if (watching.current === controller) watching.current = null;
      }
    })();

    return () => {
      controller.abort();
      if (watching.current === controller) watching.current = null;
    };
  }, [open, allowDownloads, setDownload, refresh]);

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

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Model"
      actions={
        <Button
          variant="quiet"
          size="sm"
          className="text-[13px]"
          onClick={() => void refresh(true)}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
      <div className="bg-canvas sticky top-0 z-1 px-3.5 pt-3 pb-2">
        <label htmlFor="model-search" className="sr-only">
          Search models
        </label>
        <input
          id="model-search"
          type="search"
          className="border-line bg-card focus:border-brand w-full rounded-md border px-3 py-2.5"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search models"
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      <div className="flex flex-col gap-0.5 px-2.5 pb-3">
        {failure ? (
          <p className="text-danger m-0 px-3.5 py-5.5 text-center text-sm">{failure}</p>
        ) : chatModels.length === 0 ? (
          <p className="text-muted m-0 px-3.5 py-5.5 text-center text-sm">
            {loading ? 'Loading…' : query ? 'No models match.' : 'No models found.'}
          </p>
        ) : (
          chatModels.map((model) => (
            <ModelRow
              key={model.alias}
              model={model}
              current={model.alias === selected}
              onChoose={() => void choose(model)}
            />
          ))
        )}
      </div>

      {download ? <DownloadStrip job={download} onCancel={() => void cancelDownload()} /> : null}
    </Sheet>
  );
}

function ModelRow({
  model,
  current,
  onChoose,
}: {
  model: ModelEntry;
  current: boolean;
  onChoose(): void;
}) {
  const size = formatBytes(model.cached ? model.cached_bytes : model.size_bytes);

  return (
    <button
      type="button"
      // A 3px leading rule plus a neutral fill, not a tinted wash: a 4-6%
      // tint is invisible on a phone in daylight.
      className={cn(
        'hover:bg-line-soft flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left',
        current && 'bg-line-soft shadow-[inset_3px_0_0_var(--amber-deep)]',
      )}
      onClick={onChoose}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[14.5px] font-medium [overflow-wrap:anywhere]">{model.alias}</span>
        <span className="text-muted flex items-center gap-1.5 text-xs">
          {size ?? 'size unknown'}
          {model.reasoning_parser ? <Capability>thinks</Capability> : null}
          {model.tool_call_parser ? <Capability>tools</Capability> : null}
        </span>
      </span>
      <span
        className={cn(
          'shrink-0 rounded-full px-2 py-[3px] text-[11px]',
          model.cached
            ? 'text-green bg-[color-mix(in_srgb,var(--green)_14%,transparent)]'
            : 'bg-line-soft text-faint',
        )}
      >
        {model.cached ? 'on disk' : 'remote'}
      </span>
    </button>
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
        'border-line-soft sticky bottom-0 border-t px-3.5 pt-2.5 pb-[calc(env(safe-area-inset-bottom)+10px)]',
        failed ? 'bg-[color-mix(in_srgb,var(--danger)_8%,var(--card))]' : 'bg-amber-tint',
      )}
    >
      <div className="mb-[7px] flex items-center gap-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-medium">{job.alias ?? 'Downloading'}</span>
        <span className={cn('font-mono text-[11.5px]', failed ? 'text-danger' : 'text-amber-deep')}>
          {label}
        </span>
        {job.state === 'running' ? (
          <Button variant="quiet" size="sm" className="text-[13px]" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      <div className="h-[3px] overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--amber)_22%,transparent)]">
        <div
          className={cn('h-full transition-[width] duration-300', failed ? 'bg-danger' : 'bg-amber-deep')}
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
      {job.detail ? <p className="text-muted m-0 mt-1.5 text-[11.5px]">{job.detail}</p> : null}
    </div>
  );
}

function Capability({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-brand-tint text-brand rounded-full px-1.5 py-px text-[10.5px] tracking-[0.02em]">
      {children}
    </span>
  );
}
