// Connects Locus to Claude Code and Claude Desktop (UI spec §6.1): shown once when Claude is found
// on the computer (and again after an update that brings newer Claude tools), and from Settings.
import { useEffect, useState } from 'react';
import type { ClaudeStatus } from '../shared/api';
import { api } from './api';
import { Icon } from './icons';

type Target = 'code' | 'desktop';

/** True when Claude is installed here and its Locus tools are missing or older than this app's. */
export function claudeNeedsSetup(s: ClaudeStatus): boolean {
  return (s.code.found && s.code.installed?.version !== s.code.current) || (s.desktop.found && s.desktop.installed?.version !== s.desktop.current);
}

export function ClaudeDialog({ first, onClose }: { first: boolean; onClose(): void }) {
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [busy, setBusy] = useState<Target | null>(null);
  const [messages, setMessages] = useState<Partial<Record<Target, { ok: boolean; text: string }>>>({});
  /** Restarting Claude Desktop: 'ask' shows what will happen before doing it. */
  const [restart, setRestart] = useState<'ask' | 'busy' | null>(null);

  const restartDesktop = async () => {
    setRestart('busy');
    const r = await api.restartClaudeDesktop().catch((e) => ({ ok: false, message: String((e as Error).message) }));
    setMessages((m) => ({ ...m, desktop: { ok: r.ok, text: r.message } }));
    setRestart(null);
    if (r.ok) setRestarted(true);
    void load();
  };
  const [restarted, setRestarted] = useState(false);

  const load = () => api.claudeStatus().then(setStatus, () => setStatus(null));
  useEffect(() => {
    void load();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const connect = async (t: Target) => {
    setBusy(t);
    const r = await api.connectClaude(t).catch((e) => ({ ok: false, message: String((e as Error).message) }));
    setMessages((m) => ({ ...m, [t]: { ok: r.ok, text: r.message } }));
    setBusy(null);
    void load();
  };

  const row = (t: Target, name: string, what: string) => {
    const s = status?.[t];
    const installed = s?.installed;
    const upToDate = installed && installed.version === s.current;
    const state = !status
      ? 'Checking…'
      : !s!.found
        ? 'Not found on this computer'
        : upToDate
          ? `Connected · ${installed.version}`
          : installed
            ? `Update available · ${installed.version || 'older version'} → ${s!.current}`
            : 'Not connected';
    const msg = messages[t];
    return (
      <div className="claude-row" key={t}>
        <div className="claude-row-head">
          <div>
            <div style={{ fontWeight: 600 }}>{name}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>{what}</div>
          </div>
          <div className="spacer" />
          <span className={'badge ' + (upToDate ? 'accent' : s?.found ? 'mark' : 'muted')}>{state}</span>
          {s?.found && !upToDate && (
            <button className="primary" disabled={busy !== null} onClick={() => void connect(t)}>
              {busy === t ? 'Working…' : installed ? 'Update' : 'Connect'}
            </button>
          )}
        </div>
        {msg && <div className={'claude-msg' + (msg.ok ? '' : ' bad')}>{msg.text}</div>}
        {/* After connecting, Claude Desktop only sees Locus once it starts again. */}
        {t === 'desktop' && msg?.ok && !restarted && status?.desktop.running && (
          <div className="claude-restart">
            {restart === 'ask' ? (
              <>
                <span>Claude Desktop will close and open again. Chats in progress stop; they're saved and you can reopen them.</span>
                <button className="primary" onClick={() => void restartDesktop()}>Restart now</button>
                <button className="outline" onClick={() => setRestart(null)}>Cancel</button>
              </>
            ) : (
              <button className="outline" disabled={restart === 'busy'} onClick={() => setRestart('ask')}>
                <Icon name="sync" size={13} /> {restart === 'busy' ? 'Restarting…' : 'Restart Claude Desktop'}
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const none = status && !status.code.found && !status.desktop.found;
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="locus-dialog claude-dialog" style={{ width: 560 }}>
        <div className="dialog-head">
          <h2>{first ? 'Use Locus with Claude?' : 'Claude'}</h2>
        </div>
        <div className="dialog-body" style={{ display: 'grid', gap: 12 }}>
          <div style={{ lineHeight: 1.5 }}>
            Claude can read your workspace and write notes, tours and flowcharts whose links jump to the exact page, lines or cells. Locus can set this up for
            you; nothing is sent anywhere.
          </div>
          {row('code', 'Claude Code', 'Adds the Locus tools and skill to Claude Code')}
          {row('desktop', 'Claude Desktop', 'Adds Locus to Claude Desktop; reopen Claude Desktop afterwards')}
          {none && <div className="muted">Neither Claude Code nor Claude Desktop is installed on this computer. Install one, then come back here from Settings.</div>}
        </div>
        <div className="dialog-foot">
          <span className="muted" style={{ fontSize: 12.5, marginRight: 'auto' }}>
            <Icon name="settings" size={12} /> You can do this later in Settings
          </span>
          <button className="outline" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
