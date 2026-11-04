interface QuitEvent { preventDefault(): void }
interface QuitApp {
  on(event: 'before-quit', listener: (event: QuitEvent) => void): unknown;
  quit(): void;
}

interface WindowTarget {
  isDestroyed(): boolean;
  webContents: { isDestroyed(): boolean; send(channel: string, payload: unknown): void };
}

/** A window may already be closed while its final clip is being saved. UI delivery is best-effort. */
export function sendIfOpen(window: WindowTarget | undefined, channel: string, payload: unknown): boolean {
  if (!window || window.isDestroyed()) return false;
  try {
    if (window.webContents.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

/** Electron must remain alive while replay footage is being muxed and its sidecar is written. */
export function installGracefulShutdown(app: QuitApp, cleanup: () => Promise<void>, onError: (error: unknown) => void): void {
  let ready = false;
  let closing = false;
  app.on('before-quit', event => {
    if (ready) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      try {
        await cleanup();
      } catch (error) {
        onError(error);
      } finally {
        ready = true;
        app.quit();
      }
    })();
  });
}
