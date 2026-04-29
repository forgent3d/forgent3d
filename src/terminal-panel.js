/**
 * Embedded terminal panel -- xterm.js wrapper
 *
 * Each createSession() call destroys the previous Terminal instance and creates a new one,
 * while keeping the same DOM container (#term-container).
 */
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Unicode11Addon } from '@xterm/addon-unicode11';

const THEME = {
  background:          '#0a0c11',
  foreground:          '#d7dbe3',
  cursor:              '#6ee7ff',
  cursorAccent:        '#0a0c11',
  selectionBackground: 'rgba(110,231,255,0.18)',
  black:               '#11141b',  brightBlack:   '#4a5368',
  red:                 '#ff6e6e',  brightRed:     '#ff9999',
  green:               '#4ade80',  brightGreen:   '#86efac',
  yellow:              '#f5c04c',  brightYellow:  '#fde68a',
  blue:                '#6ee7ff',  brightBlue:    '#bae6fd',
  magenta:             '#a78bfa',  brightMagenta: '#c4b5fd',
  cyan:                '#67e8f9',  brightCyan:    '#a5f3fc',
  white:               '#d7dbe3',  brightWhite:   '#f1f5f9'
};

export function createTerminalPanel(containerEl, api) {
  let xterm      = null;
  let fitAddon   = null;
  let termId     = null;
  let resizeObserver = null;
  let hasBoundFocusHandlers = false;
  let onContainerPointerDown = null;
  let onWindowFocus = null;

  function ensureFocused() {
    try { xterm?.focus(); } catch {}
    requestAnimationFrame(() => {
      try { xterm?.focus(); } catch {}
    });
    setTimeout(() => {
      try { xterm?.focus(); } catch {}
    }, 140);
  }

  /* ---- Initialize / recreate xterm instance ---- */
  function mount() {
    // Detach from old PTY session before rebuilding the terminal view.
    termId = null;
    if (xterm) { xterm.dispose(); xterm = null; fitAddon = null; }
    containerEl.innerHTML = '';

    xterm = new Terminal({
      theme:       THEME,
      fontFamily:  '"JetBrains Mono", Consolas, "Courier New", monospace',
      fontSize:    13,
      lineHeight:  1.4,
      cursorBlink: true,
      convertEol:  true,
      scrollback:  5000,
      macOptionIsMeta: true,
      allowProposedApi: true
    });

    const unicode11Addon = new Unicode11Addon();
    xterm.loadAddon(unicode11Addon);
    xterm.unicode.activeVersion = '11';

    fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerEl);
    containerEl.tabIndex = -1;

    // Fit after one frame to avoid measuring before layout is ready
    requestAnimationFrame(() => {
      try { fitAddon.fit(); } catch {}
      ensureFocused();
    });

    // Keyboard input -> main process
    xterm.onData((data) => {
      if (termId) api.terminalWrite(termId, data);
    });

    xterm.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const key = (ev.key || '').toLowerCase();
      const isModifier = ev.ctrlKey || ev.metaKey;
      const isShift = ev.shiftKey;
      const hasSelection = !!xterm?.hasSelection?.();

      // Copy selected text:
      // - Ctrl/Cmd+C when there is a selection
      // - Ctrl/Cmd+Shift+C (xterm common convention)
      if (isModifier && key === 'c' && (hasSelection || isShift)) {
        const selected = xterm?.getSelection?.() || '';
        if (selected) {
          api.clipboardWriteText(selected).catch(() => {});
        }
        ev.preventDefault();
        return false;
      }

      // Paste text:
      // - Ctrl/Cmd+V
      // - Ctrl/Cmd+Shift+V (xterm common convention)
      if (isModifier && key === 'v') {
        api.clipboardReadText()
          .then((text) => {
            if (!termId || !text) return;
            api.terminalWrite(termId, String(text));
          })
          .catch(() => {});
        ev.preventDefault();
        return false;
      }

      // Shift+Insert paste support (common in terminal apps on Windows/Linux).
      if (!isModifier && isShift && key === 'insert') {
        api.clipboardReadText()
          .then((text) => {
            if (!termId || !text) return;
            api.terminalWrite(termId, String(text));
          })
          .catch(() => {});
        ev.preventDefault();
        return false;
      }

      return true;
    });

    // PTY resize notification
    xterm.onResize(({ cols, rows }) => {
      if (termId) api.terminalResize(termId, cols, rows);
    });

    // Auto-fit on container resize
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      try { fitAddon?.fit(); } catch {}
    });
    resizeObserver.observe(containerEl);

    if (!hasBoundFocusHandlers) {
      onContainerPointerDown = () => ensureFocused();
      onWindowFocus = () => {
        if (termId) ensureFocused();
      };
      containerEl.addEventListener('pointerdown', onContainerPointerDown);
      window.addEventListener('focus', onWindowFocus);
      hasBoundFocusHandlers = true;
    }
  }

  /* ---- Public API ---- */

  /** Bind current PTY session id and focus xterm so subsequent key input
   *  (including IME composition keys) goes directly to the hidden textarea. */
  function attachSession(id) {
    const wasSwitched = termId !== id;
    termId = id;
    // For a new PTY session, always reset terminal modes/buffer to avoid stale
    // alternate-screen artifacts (common in full-screen terminal TUIs).
    if (wasSwitched && id) {
      try { xterm?.reset(); } catch {}
      try { xterm?.clear(); } catch {}
    }
    // Only take focus when actually binding a live session.
    if (!id) return;
    // xterm.open() does not focus automatically; retry focus around layout transitions.
    ensureFocused();
  }

  /** Write data chunk from main process */
  function write(data) {
    xterm?.write(data);
  }

  /** Manually trigger fit (call after panel height changes) */
  function fit() {
    try { fitAddon?.fit(); } catch {}
  }

  /** Explicitly focus (same as clicking inside xterm) */
  function focus() {
    try { xterm?.focus(); } catch {}
  }

  /** Read current xterm geometry after fit */
  function getSize() {
    return {
      cols: xterm?.cols || 0,
      rows: xterm?.rows || 0,
      width: containerEl?.offsetWidth || 0,
      height: containerEl?.offsetHeight || 0
    };
  }

  /** Print informational line in terminal (non-PTY data) */
  function printInfo(text) {
    xterm?.writeln(`\r\n\x1b[2m${text}\x1b[0m\r\n`);
  }

  /** Close and dispose */
  function dispose() {
    resizeObserver?.disconnect();
    if (hasBoundFocusHandlers) {
      if (onContainerPointerDown) {
        containerEl.removeEventListener('pointerdown', onContainerPointerDown);
      }
      if (onWindowFocus) {
        window.removeEventListener('focus', onWindowFocus);
      }
      hasBoundFocusHandlers = false;
      onContainerPointerDown = null;
      onWindowFocus = null;
    }
    xterm?.dispose();
    xterm = null; fitAddon = null; termId = null;
    containerEl.innerHTML = '';
  }

  function getTermId() { return termId; }

  mount();
  return { attachSession, write, fit, focus, getSize, printInfo, dispose, getTermId, mount };
}
