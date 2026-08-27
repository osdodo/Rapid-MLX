import { useEffect, useMemo, useRef, useState } from 'react';
import { cancelDownload, fetchModels, loadModel, pullModel, watchDownloads } from '@/api/models';
import { asApiError } from '@/api/errors';
import type { DownloadJob, ModelEntry, StatusResponse } from '@/api/types';
import { formatBytes } from '@/lib/format';
import { useStore } from '@/state/store';
import { noticeFor } from '@/state/notices';
import { percent } from '@/components/models/LifecycleBand';
import { Sheet } from '@/components/common/Sheet';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

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
        <Button variant="ghost" size="sm" onClick={() => void refresh(true)} disabled={loading}>
          {loading ? 'Refreshing…' : 'Refresh'}
        </Button>
      }
    >
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
      className={cn(
        'hover:bg-accent flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left outline-none',
        current && 'bg-accent',
      )}
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
