/**
 * Id generation.
 *
 * `crypto.randomUUID` is only available in a SECURE CONTEXT. A tunnel without
 * TLS, or a plain `--host 0.0.0.0` LAN bind, is not one — the same reason the
 * old page carried a clipboard fallback (index.html:1382-1397). There
 * `randomUUID` is simply `undefined`, and calling it throws on every single id
 * generation, which is every message and every conversation.
 *
 * The fallback does not need to be cryptographically strong. These ids are
 * local keys in one browser's storage; nothing authenticates or authorises on
 * them. It needs to be unique, and monotonic-ish so `precedes` has a sensible
 * tie-break.
 */

let counter = 0;

export function newId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID();
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
