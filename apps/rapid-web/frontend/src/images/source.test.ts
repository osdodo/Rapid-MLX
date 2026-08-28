import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImageSourceError, readImageSource } from './source';

/**
 * The probe's URL scheme is the point of these specs.
 *
 * The page runs under `img-src 'self' data:`, so an object URL is refused and
 * the probe fires `error` — which surfaced as "that file isn't a readable
 * image" for every perfectly good file.
 */

/** Captures what the size probe was pointed at, and reports `dimensions`. */
function stubImage(dimensions: { width: number; height: number } | null): { src?: string } {
  const seen: { src?: string } = {};
  class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = dimensions?.width ?? 0;
    naturalHeight = dimensions?.height ?? 0;
    set src(value: string) {
      seen.src = value;
      queueMicrotask(() => (dimensions ? this.onload?.() : this.onerror?.()));
    }
  }
  vi.stubGlobal('Image', FakeImage);
  return seen;
}

function pngFile(name = 'photo.png'): File {
  // Only the magic bytes matter — the format is sniffed, not read from
  // `File.type`, which is empty from some Android pickers.
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], name, {
    type: 'image/png',
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('readImageSource', () => {
  it('measures from a data: URL, never a blob:', async () => {
    const probe = stubImage({ width: 512, height: 512 });
    const source = await readImageSource(pngFile());

    expect(probe.src).toMatch(/^data:image\/png;base64,/);
    expect(probe.src).not.toMatch(/^blob:/);
    // The same encoding the request carries, so measuring costs nothing extra.
    expect(probe.src).toBe(`data:image/png;base64,${source.data}`);
  });

  it('sniffs the format rather than trusting the file type', async () => {
    stubImage({ width: 8, height: 8 });
    const mislabelled = new File([new Uint8Array([0, 1, 2, 3])], 'x.png', {
      type: 'image/png',
    });

    await expect(readImageSource(mislabelled)).rejects.toBeInstanceOf(ImageSourceError);
  });

  it("refuses an image past the engine's pixel ceiling", async () => {
    stubImage({ width: 9000, height: 9000 });
    await expect(readImageSource(pngFile())).rejects.toThrow(/8192 px/);
  });

  it('names the source by its filename, without the extension', async () => {
    stubImage({ width: 64, height: 64 });
    const source = await readImageSource(pngFile('beach sunset.png'));

    expect(source.label).toBe('beach sunset');
    expect(source.mediaType).toBe('image/png');
  });
});
