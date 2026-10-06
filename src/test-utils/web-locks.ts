type LockMode = 'exclusive' | 'shared';
type PendingRequest = { mode: LockMode; grant: () => void };
type LockState = { held: LockMode | null; holders: number; queue: PendingRequest[] };

/**
 * A Web Locks stand-in shared by every "tab" of a test, with the browser's
 * grant rules: per name, requests are granted in order; an exclusive
 * request waits for every holder, and a shared request waits for an
 * exclusive holder and for any request queued ahead of it. `signal`
 * aborts a request still waiting; `ifAvailable` runs the callback with
 * null instead of waiting. jsdom has no `navigator.locks`.
 */
export function installWebLocks(): void {
  const states = new Map<string, LockState>();
  const stateOf = (name: string): LockState => {
    let state = states.get(name);
    if (!state) {
      state = { held: null, holders: 0, queue: [] };
      states.set(name, state);
    }
    return state;
  };
  const drain = (state: LockState) => {
    while (state.queue.length > 0) {
      const next = state.queue[0];
      const grantable = state.holders === 0 || (state.held === 'shared' && next.mode === 'shared');
      if (!grantable) return;
      state.queue.shift();
      state.held = next.mode;
      state.holders += 1;
      next.grant();
      if (next.mode === 'exclusive') return;
    }
  };
  const request = async <T>(
    name: string,
    optionsOrCallback:
      | { mode?: LockMode; signal?: AbortSignal; ifAvailable?: boolean }
      | ((lock: { name: string; mode: LockMode } | null) => Promise<T>),
    maybeCallback?: (lock: { name: string; mode: LockMode } | null) => Promise<T>,
  ): Promise<T> => {
    const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
    const mode = options.mode ?? 'exclusive';
    const state = stateOf(name);
    // `ifAvailable`: granted only if it could be granted now, else the callback runs with null.
    const available =
      state.queue.length === 0 && (state.holders === 0 || (state.held === 'shared' && mode === 'shared'));
    if (options.ifAvailable && !available) return await callback(null);
    await new Promise<void>((resolve, reject) => {
      const pending: PendingRequest = { mode, grant: resolve };
      if (options.signal?.aborted) {
        reject(new DOMException('The lock request was aborted.', 'AbortError'));
        return;
      }
      options.signal?.addEventListener('abort', () => {
        const index = state.queue.indexOf(pending);
        if (index === -1) return;
        state.queue.splice(index, 1);
        reject(new DOMException('The lock request was aborted.', 'AbortError'));
        drain(state);
      });
      state.queue.push(pending);
      drain(state);
    });
    try {
      return await callback({ name, mode });
    } finally {
      state.holders -= 1;
      if (state.holders === 0) state.held = null;
      drain(state);
    }
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}

/** A lock manager that refuses every request (or those `refuses` names), as a browser may do; the rest are granted. */
export function installRefusingWebLocks(error: unknown, refuses: (name: string) => boolean = () => true): void {
  installWebLocks();
  const granting = (navigator as Navigator & { locks: { request: (...args: unknown[]) => Promise<unknown> } }).locks;
  const request = async (name: string, ...rest: unknown[]) => {
    if (refuses(name)) throw error;
    return await granting.request(name, ...rest);
  };
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
}

export function removeWebLocks(): void {
  Reflect.deleteProperty(navigator, 'locks');
}
