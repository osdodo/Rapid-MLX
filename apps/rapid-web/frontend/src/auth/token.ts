import { setToken } from '@/api/client';

/**
 * Token acquisition.
 *
 * The token arrives in the URL FRAGMENT, never the query string. A fragment is
 * not transmitted to the server, so it cannot reach an access log, a proxy
 * log, or the tunnel provider's request history — all of which a `?token=`
 * would. The CLI generates the link that way (cli.py:148-163) and the page's
 * job is to consume it and get it out of the address bar immediately, so it
 * does not linger in browser history or in a screenshot of the URL.
 */

/**
 * Keeps the pre-rename spelling on purpose — see the note on `HISTORY_KEY`
 * in state/migrate.ts. Renaming this one costs less than the history key
 * (a signed-in phone would just be asked for its token again), but it is the
 * same mistake, and the two keys are only discoverable together.
 */
export const TOKEN_KEY = 'rapid-mlx-web.token';

/** Read and strip a token from the URL fragment. */
export function consumeFragmentToken(): string | null {
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (!match?.[1]) return null;

  let token: string;
  try {
    token = decodeURIComponent(match[1]);
  } catch {
    // A malformed escape sequence. Not a usable token.
    return null;
  }

  try {
    // Drops the whole fragment, not just the token, so nothing survives in
    // history. `replaceState` rather than assigning `hash`, which would push
    // a new entry and leave the token one Back away.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch {
    window.location.hash = '';
  }

  return token;
}

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function rememberToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private browsing. The session still works; it just will not survive a
    // reload, which is better than refusing to start.
  }
  setToken(token);
}

export function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to do; the in-memory token is cleared regardless.
  }
  setToken(null);
}
