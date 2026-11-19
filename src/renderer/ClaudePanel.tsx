// The Claude panel (UI spec §6.3): the user's own Claude Code, or a plain terminal, running in the
// workspace folder at the right of the window. What is selected in a note or a document shows as a
// chip above the terminal, and Add puts it into the prompt as a Locus reference link. Claude reads
// what is on screen, and opens places, through the locus-live tools (src/main/live.ts).
import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ClaudeStatus, TerminalKind, TerminalStart } from '../shared/api';
import { api } from './api';
import { Icon } from './icons';

/** What the user has selected (or has in view) that can go into the prompt. */
export interface PanelChip {
  /** "selected" when the user picked something out; "view" when it is only what is on screen. */
  kind: 'selected' | 'view';
  where: 'note' | 'document';
  label: string;
  /** The Locus reference link that goes into the prompt. */
  link: string;
}

type Status =
  | { s: 'starting' }
  | { s: 'running'; kind: TerminalKind }
  | { s: 'ended'; kind: TerminalKind; code: number }
  | { s: 'error'; reason: Exclude<TerminalStart, { ok: true }>['reason']; message?: string };

interface Events {
  onTerminalData?(cb: (data: string) => void): () => void;
  onTerminalExit?(cb: (info: { code: number }) => void): () => void;
}
const events = () => (window as unknown as { locusEvents?: Events }).locusEvents;

function themeFor(dark: boolean) {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: v('--panel', dark ? '#1b1f1d' : '#ffffff'),
    foreground: v('--text', dark ? '#e6e8e6' : '#1f2328'),
    cursor: v('--accent', '#1f5c45'),
    cursorAccent: v('--panel', '#ffffff'),
    selectionBackground: dark ? 'rgba(160, 200, 180, 0.35)' : 'rgba(31, 92, 69, 0.22)',
  };
}

export function ClaudePanel({
  visible,
  dark,
  workspace,
  pick,
  onClose,
  onSetup,
}: {
  visible: boolean;
  dark: boolean;
  /** The workspace folder: the session restarts when it changes. */
  workspace: string;
  /** Reads what is selected right now (polled while the panel shows). */
  pick(): PanelChip | null;
  onClose(): void;
  onSetup(): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const [status, setStatus] = useState<Status>({ s: 'starting' });
  const [chip, setChip] = useState<PanelChip | null>(null);
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [hideSetup, setHideSetup] = useState(false);
  const pickRef = useRef(pick);
  pickRef.current = pick;

  /** Fits the terminal to the panel (not while hidden, when it has no size) and tells the session. */
  const refit = () => {
    const t = term.current;
    const el = host.current;
    if (!t || !fit.current || !el || el.clientWidth < 40 || el.clientHeight < 40) return;
    try {
      fit.current.fit();
    } catch {
      return;
    }
    void api.terminalResize(t.cols, t.rows);
  };

  const start = async (kind: TerminalKind) => {
    const t = term.current;
    if (!t) return;
    setStatus({ s: 'starting' });
    t.reset();
    refit();
    const r = await api.terminalStart(kind, t.cols, t.rows).catch((e) => ({ ok: false as const, reason: 'failed' as const, message: String(e) }));
    if (r.ok) {
      setStatus({ s: 'running', kind: r.kind });
      t.focus();
    } else setStatus({ s: 'error', reason: r.reason, message: r.message });
  };

  // The terminal itself: made once, kept while the panel is hidden so the session goes on.
  useEffect(() => {
    const t = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
      theme: themeFor(dark),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    // Copy with Ctrl+C when text is selected (otherwise Ctrl+C interrupts, as in any terminal); Ctrl+V
    // and Ctrl+Shift+V paste through the browser, which xterm takes as a paste.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === 'c' && (e.shiftKey || t.hasSelection())) {
        void api.copyText(t.getSelection());
        t.clearSelection();
        return false;
      }
      if (e.ctrlKey && k === 'v') return false;
      return true;
    });
    const typed = t.onData((d) => void api.terminalWrite(d));
    const offData = events()?.onTerminalData?.((d) => t.write(d));
    const offExit = events()?.onTerminalExit?.(({ code }) =>
      setStatus((s) => (s.s === 'running' ? { s: 'ended', kind: s.kind, code } : s)),
    );
    const ro = new ResizeObserver(() => refit());
    ro.observe(host.current!);
    return () => {
      ro.disconnect();
      typed.dispose();
      offData?.();
      offExit?.();
      t.dispose();
      term.current = null;
    };
  }, []);

  // Start Claude when the panel first shows for a workspace, or pick the session back up after the
  // window reloads.
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || startedFor.current === workspace) return;
    startedFor.current = workspace;
    void (async () => {
      const running = await api.terminalState().catch(() => null);
      if (running) {
        setStatus({ s: 'running', kind: running.kind });
        refit();
      } else await start('claude');
    })();
    void api.claudeStatus().then(setClaude).catch(() => undefined);
  }, [visible, workspace]);

  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => {
      refit();
      term.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  useEffect(() => {
    if (term.current) term.current.options.theme = themeFor(dark);
  }, [dark]);

  // What is selected changes without telling anyone, so look again a few times a second.
  useEffect(() => {
    if (!visible) return;
    const look = () => {
      const next = pickRef.current();
      setChip((c) => (c?.link === next?.link && c?.kind === next?.kind ? c : next));
    };
    look();
    const id = setInterval(look, 500);
    return () => clearInterval(id);
  }, [visible]);

  const insert = () => {
    const t = term.current;
    if (!t || !chip) return;
    t.paste(`${chip.link} `);
    t.focus();
  };

  const kind = status.s === 'running' || status.s === 'ended' ? status.kind : 'claude';
  const needsSetup = !hideSetup && claude?.code.found && !claude.code.installed && kind === 'claude' && status.s === 'running';

  return (
    <div className="claude-panel" style={{ display: visible ? 'flex' : 'none' }}>
      <div className="claude-head">
        <span className="claude-title">
          <Icon name="terminal" /> {kind === 'shell' ? 'Terminal' : 'Claude Code'}
        </span>
        <div className="spacer" />
        <button
          className="icon"
          title={kind === 'shell' ? 'Run Claude Code here instead' : 'Run a plain terminal here instead'}
          onClick={() => void start(kind === 'shell' ? 'claude' : 'shell')}
        >
          <Icon name={kind === 'shell' ? 'flow' : 'code'} />
        </button>
        <button className="icon" title="Start again (ends what is running)" onClick={() => void start(kind)}>
          <Icon name="sync" />
        </button>
        <button className="icon" title="Hide the panel (what runs in it keeps going)" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>

      {needsSetup && (
        <div className="claude-note">
          <div className="notice-body">
            <div>Claude Code doesn't have the Locus tools yet.</div>
            <div className="notice-help">
              It can already see what you have open and show you places. With the Locus tools it can also make reference links and write notes. Set up adds them; then press Start again.
            </div>
          </div>
          <button className="outline" onClick={onSetup}>Set up</button>
          <button className="icon" title="Hide this" onClick={() => setHideSetup(true)}><Icon name="x" /></button>
        </div>
      )}

      <div className="claude-chip-row">
        {chip ? (
          <>
            <span className="claude-chip-where">{chip.kind === 'selected' ? 'Selected' : 'In view'} in the {chip.where}:</span>
            <span className="claude-chip" title={chip.link}>
              <Icon name="link" size={13} /> {chip.label}
            </span>
            <button className="outline small" title="Puts a link to this place into what you are typing to Claude" onClick={insert} disabled={status.s !== 'running'}>
              Add to prompt
            </button>
          </>
        ) : (
          <span className="claude-chip-where">Select text in a note or a document to add it to the prompt.</span>
        )}
      </div>

      <div className="claude-term-wrap">
        <div ref={host} className="claude-term" />
        {status.s === 'error' && status.reason === 'no-claude' && (
          <div className="claude-cover">
            <h3>Claude Code isn't installed</h3>
            <p>
              This panel runs Claude Code, Anthropic's command-line Claude, signed in with your own account. To install it, run
              <code> irm https://claude.ai/install.ps1 | iex </code> in PowerShell (or <code>winget install Anthropic.ClaudeCode</code>), run
              <code> claude </code> once to sign in, then press Try again.
            </p>
            <p>Open a plain terminal to run those here, in this workspace's folder. Instructions: code.claude.com/docs/en/setup</p>
            <div className="claude-cover-actions">
              <button className="primary" onClick={() => void start('claude')}>Try again</button>
              <button className="outline" onClick={() => void start('shell')}>Open a plain terminal</button>
            </div>
          </div>
        )}
        {status.s === 'error' && status.reason !== 'no-claude' && (
          <div className="claude-cover">
            <h3>{status.reason === 'no-workspace' ? 'Open a workspace first' : "The terminal couldn't start"}</h3>
            <p>{status.reason === 'no-workspace' ? 'Claude runs in the workspace folder, so it starts once one is open.' : (status.message ?? 'Something went wrong starting it.')}</p>
            <div className="claude-cover-actions">
              <button className="primary" onClick={() => void start('claude')}>Try again</button>
              <button className="outline" onClick={() => void start('shell')}>Open a plain terminal</button>
            </div>
          </div>
        )}
        {status.s === 'ended' && (
          <div className="claude-ended">
            <span>{status.kind === 'shell' ? 'The terminal' : 'Claude Code'} has ended.</span>
            <button className="outline small" onClick={() => void start(status.kind)}>Start again</button>
            {status.kind === 'claude' && <button className="outline small" onClick={() => void start('shell')}>Plain terminal</button>}
          </div>
        )}
      </div>
    </div>
  );
}
