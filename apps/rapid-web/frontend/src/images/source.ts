/**
 * Reading a source image for an edit.
 *
 * The limits mirror the engine's own (`routes/images.py` `_validate_edit_image`)
 * so a file it would refuse is refused here, before a 25 MB upload crosses two
 * hops to learn that.
 */

/** `_MAX_EDIT_IMAGE_BYTES`. */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_EDGE = 8192;
const MAX_PIXELS = 40_000_000;

export interface ImageSource {
  /** Base64 bytes, without a `data:` prefix — what the API field carries. */
  data: string;
  /** For the `<img>` src and the caption. */
  mediaType: 'image/png' | 'image/jpeg';
  label: string;
}

export class ImageSourceError extends Error {}

/**
 * Sniffs the format from the bytes rather than trusting `File.type`, which is
 * derived from the extension and is empty for a file picked from some Android
 * pickers.
 */
function sniff(bytes: Uint8Array): ImageSource['mediaType'] | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked: `String.fromCharCode(...bytes)` on a multi-megabyte array blows
  // the argument limit and throws RangeError.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/**
 * Measure from a `data:` URL, NOT an object URL.
 *
 * The page's CSP is `img-src 'self' data:`, so a `blob:` src is refused and
 * the probe fires `error` — which reads as "that file isn't a readable
 * image" for every perfectly good file. The bytes are being base64-encoded
 * for the request anyway, so measuring the same string costs nothing extra.
 */
function measure(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => reject(new ImageSourceError("That file isn't a readable image."));
    probe.src = dataUrl;
  });
}

/** Validate and encode a picked file. Throws `ImageSourceError` with copy the
 *  user can act on. */
export async function readImageSource(file: File): Promise<ImageSource> {
  if (file.size > MAX_SOURCE_BYTES) {
    throw new ImageSourceError(
      `Choose an image smaller than ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.`,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = sniff(bytes);
  if (mediaType === null) throw new ImageSourceError('Choose a PNG or JPEG image.');

  const data = toBase64(bytes);
  const { width, height } = await measure(`data:${mediaType};base64,${data}`);
  if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
    throw new ImageSourceError('Choose an image no larger than 8192 px or 40 megapixels.');
  }

  return {
    data,
    mediaType,
    // The filename without its extension, matching rapid-mac — it is what the
    // source strip shows under "Editing image".
    label: file.name.replace(/\.[^.]+$/, '') || 'Imported image',
  };
}
