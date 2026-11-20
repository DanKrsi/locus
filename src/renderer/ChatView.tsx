// The Claude panel's chat (UI spec §6.3): messages with Claude, what it does in Locus as it does
// it, and its requests to change things, answered with Allow / Allow for this chat / Deny. Claude
// itself is the user's own Claude Code, run in the background by main (src/main/chat.ts). Every
// piece of text here is drawn as text (links as buttons), never as HTML: what Claude writes can
// come from files in a shared workspace.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ChatAnswer, ChatEvent, ChatItem, ChatStart } from '../shared/api';
import { api } from './api';
import { Icon } from './icons';
import type { PanelChip } from './ClaudePanel';

interface Events {
  onChatEvent?(cb: (ev: ChatEvent) => void): () => void;
}
const events = () => (window as unknown as { locusEvents?: Events }).locusEvents;

/** A tool's last name part: "mcp__locus-live__edit_note" → "edit_note". */
const toolName = (name: string) => name.split('__').pop() ?? name;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const fileName = (p: unknown) => str(p).split(/[\\/]/).pop() || str(p);
const shortText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
/** The words of a "[label](dest)" link, or the text itself. */
const linkWords = (s: unknown) => {
  const m = str(s).match(/^\s*!?\[([^\]]*)\]/);
  return m ? m[1] : shortText(str(s).replace(/^<|>$/g, ''), 60);
};

/** What a tool use says in the chat, in plain words; null hides it (Claude's own housekeeping). */
function toolLine(name: string, input: Record<string, unknown>): string | null {
  const note = (p: unknown) => str(p) || 'the open note';
  switch (toolName(name)) {
    case 'ToolSearch':
      return null;
    case 'current_view':
      return 'Looked at what you have open';
    case 'read_note':
      return `Read ${note(input.path)}`;
    case 'screenshot':
      return input.part && input.part !== 'window' ? `Looked at the ${input.part} pane` : 'Looked at the screen';
    case 'show':
      return `Opened ${linkWords(input.link)}`;
    case 'edit_note':
      return `Changed ${note(input.path)}`;
    case 'insert_text':
      return `Added text to ${note(input.path)}`;
    case 'cite_selection':
      return `Cited your selection in ${note(input.path)}`;
    case 'save_version':
      return `Saved a version: ${str(input.name)}`;
    case 'make_reference':
      return `Made a link to ${str(input.path)}`;
    case 'read_file':
      return `Read ${str(input.path)}`;
    case 'search_workspace':
      return `Searched the workspace for "${shortText(str(input.query), 60)}"`;
    case 'workspace_overview':
      return 'Looked over the workspace';
    case 'validate_note':
      return `Checked the links in ${str(input.path)}`;
    case 'write_note':
      return `Wrote ${str(input.path)}`;
    case 'write_flowchart':
      return `Wrote the flowchart ${str(input.path)}`;
    case 'file_history':
      return `Looked at the history of ${str(input.path)}`;
    case 'Read':
      return `Read ${fileName(input.file_path)}`;
    case 'Grep':
      return `Searched for "${shortText(str(input.pattern), 60)}"`;
    case 'Glob':
      return `Looked for ${shortText(str(input.pattern), 60)}`;
    case 'Bash':
    case 'PowerShell':
      return `Ran ${shortText(str(input.command), 80)}`;
    case 'Write':
      return `Wrote ${fileName(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${fileName(input.file_path)}`;
    case 'WebSearch':
      return `Searched the web for "${shortText(str(input.query), 60)}"`;
    case 'WebFetch':
      return `Read ${shortText(str(input.url), 60)}`;
    case 'TodoWrite':
      return 'Updated its to-do list';
    case 'Task':
    case 'Agent':
      return `Started a helper: ${shortText(str(input.description), 60)}`;
    default:
      return `Used ${toolName(name).replace(/_/g, ' ')}`;
  }
}

/** What Claude is asking to do, finishing "Allow Claude to …?". */
function askLine(item: Extract<ChatItem, { t: 'ask' }>): string {
  const i = item.input;
  const note = (p: unknown) => str(p) || 'the open note';
  switch (toolName(item.tool)) {
    case 'edit_note':
      return `change ${note(i.path)}`;
    case 'insert_text':
      return `add text to ${note(i.path)}`;
    case 'cite_selection':
      return `cite your selection in ${note(i.path)}`;
    case 'save_version':
      return `save a version named "${str(i.name)}"`;
    case 'write_note':
      return `write the note ${str(i.path)}`;
    case 'write_flowchart':
      return `write the flowchart ${str(i.path)}`;
    case 'Write':
      return `write ${fileName(i.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `edit ${fileName(i.file_path)}`;
    case 'Bash':
    case 'PowerShell':
      return 'run a command';
    case 'WebFetch':
      return `read ${shortText(str(i.url), 60)}`;
    case 'WebSearch':
      return `search the web for "${shortText(str(i.query), 60)}"`;
    default:
      return `use ${item.title}`;
  }
}

/** The change itself, so the user sees what they are saying yes to. */
function AskBody({ item }: { item: Extract<ChatItem, { t: 'ask' }> }) {
  const i = item.input;
  const del = (t: string, k?: string | number) => <pre key={`d${k}`} className="chat-del">{shortText(t, 4000)}</pre>;
  const ins = (t: string, k?: string | number) => <pre key={`i${k}`} className="chat-ins">{shortText(t, 4000)}</pre>;
  switch (toolName(item.tool)) {
    case 'edit_note': {
      let raw = i.edits;
      if (typeof raw === 'string') {
        try {
          raw = JSON.parse(raw);
        } catch {
          /* shown as it is below */
        }
      }
      if (!Array.isArray(raw)) return <pre className="chat-code">{shortText(JSON.stringify(i, null, 2), 3000)}</pre>;
      const edits = raw as { old_text?: unknown; new_text?: unknown }[];
      return <>{edits.map((e, k) => <Fragment key={k}>{del(str(e.old_text), k)}{str(e.new_text) ? ins(str(e.new_text), k) : <div className="chat-ask-what">(removed)</div>}</Fragment>)}</>;
    }
    case 'insert_text': {
      const where = i.after_heading ? `at the end of "${str(i.after_heading)}"` : i.after_line !== undefined ? `after line ${String(i.after_line)}` : i.at === 'cursor' ? 'at your cursor' : i.at === 'start' ? 'at the start' : 'at the end';
      return <><div className="chat-ask-what">{where}{i.create ? ' (a new note)' : ''}</div>{ins(str(i.text))}</>;
    }
    case 'cite_selection':
      return <div className="chat-ask-what">{i.embed ? 'As a picture or table of what you selected' : 'As a link to what you selected'}{i.label ? `, named "${str(i.label)}"` : ''}</div>;
    case 'save_version':
      return null;
    case 'Write':
    case 'write_note':
    case 'write_flowchart':
      return <><div className="chat-ask-what">{str(i.file_path) || str(i.path)}</div>{ins(str(i.content))}</>;
    case 'Edit':
      return <><div className="chat-ask-what">{str(i.file_path)}</div>{del(str(i.old_string))}{ins(str(i.new_string))}</>;
    case 'Bash':
    case 'PowerShell':
      return <>{i.description ? <div className="chat-ask-what">{str(i.description)}</div> : null}<pre className="chat-code">{str(i.command)}</pre></>;
    default:
      return <pre className="chat-code">{shortText(JSON.stringify(i, null, 2), 3000)}</pre>;
  }
}

// ---------- Claude's words: a little markdown, drawn as React (never as HTML) ----------

function inline(text: string, onLink: (link: string) => void, key = ''): ReactNode[] {
  const out: ReactNode[] = [];
  // Links (with <dest> or plain dest), code, bold, italic.
  const re = /(!?\[([^\]\n]*)\]\((<[^>\n]*>|[^)\s]*)(?:\s+"[^"\n]*")?\))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) {
      const words = m[2] || m[3].replace(/^<|>$/g, '');
      const dest = m[3].replace(/^<|>$/g, '');
      const link = m[1].replace(/^!/, '');
      if (/^https?:\/\//i.test(dest))
        out.push(<a key={k} href={dest} target="_blank" rel="noreferrer" title={dest}>{words}</a>);
      else
        out.push(
          <button key={k} className="chat-link" title={`Open ${dest}`} onClick={() => onLink(link)}>
            <Icon name="link" size={12} /> {words}
          </button>,
        );
    } else if (m[4]) out.push(<code key={k}>{m[4].slice(1, -1)}</code>);
    else if (m[5]) out.push(<strong key={k}>{inline(m[5].slice(2, -2), onLink, k)}</strong>);
    else if (m[6]) out.push(<em key={k}>{m[6].slice(1, -1)}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function ChatText({ text, onLink }: { text: string; onLink(link: string): void }) {
  const blocks: ReactNode[] = [];
  const parts = text.replace(/\r\n/g, '\n').split(/^```[^\n]*\n?/m);
  parts.forEach((part, pi) => {
    if (pi % 2 === 1) {
      blocks.push(<pre key={`c${pi}`} className="chat-code">{part.replace(/\n$/, '')}</pre>);
      return;
    }
    const lines = part.split('\n');
    let para: string[] = [];
    let list: { ordered: boolean; items: string[] } | null = null;
    let table: string[][] | null = null;
    const flush = () => {
      if (para.length) blocks.push(<p key={`p${pi}-${blocks.length}`}>{inline(para.join('\n'), onLink, `p${pi}-${blocks.length}`)}</p>);
      para = [];
      if (list) {
        const items = list.items.map((it, i) => <li key={i}>{inline(it, onLink, `l${pi}-${blocks.length}-${i}`)}</li>);
        blocks.push(list.ordered ? <ol key={`o${pi}-${blocks.length}`}>{items}</ol> : <ul key={`u${pi}-${blocks.length}`}>{items}</ul>);
      }
      list = null;
      if (table) {
        const rows = table.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c.trim())));
        blocks.push(
          <div key={`t${pi}-${blocks.length}`} className="chat-table-wrap">
            <table className="chat-table">
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>{r.map((c, ci) => (ri === 0 ? <th key={ci}>{inline(c.trim(), onLink)}</th> : <td key={ci}>{inline(c.trim(), onLink)}</td>))}</tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      }
      table = null;
    };
    for (const line of lines) {
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
      const head = line.match(/^#{1,6}\s+(.*)$/);
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (!table) flush();
        table ??= [];
        table.push(line.trim().replace(/^\||\|$/g, '').split('|'));
      } else if (bullet || num) {
        const ordered = !!num && !bullet;
        if (para.length || table || (list && list.ordered !== ordered)) flush();
        list ??= { ordered, items: [] };
        list.items.push((bullet ?? num)![1]);
      } else if (head) {
        flush();
        blocks.push(<p key={`h${pi}-${blocks.length}`} className="chat-head">{inline(head[1], onLink)}</p>);
      } else if (!line.trim()) flush();
      else {
        if (list || table) flush();
        para.push(line);
      }
    }
    flush();
  });
  return <div className="chat-text">{blocks}</div>;
}

// ---------- The chat ----------

/** "(Locus change c3)" at the end of a tool result: the change Show and Undo act on. */
const changeIdOf = (text: string) => text.match(/\(Locus change (c\d+)\)\s*$/)?.[1] ?? null;

function ToolRow({ item, onChange }: { item: Extract<ChatItem, { t: 'tool' }>; onChange(id: string, action: 'show' | 'undo'): Promise<string | null> }) {
  const [open, setOpen] = useState(false);
  const [undone, setUndone] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const line = toolLine(item.name, (item.input ?? {}) as Record<string, unknown>);
  if (line === null) return null;
  const state = !item.result ? 'running' : item.result.ok ? 'ok' : 'failed';
  const change = item.result?.ok ? changeIdOf(item.result.text) : null;
  const act = async (action: 'show' | 'undo') => {
    if (!change) return;
    const r = await onChange(change, action);
    setMsg(r);
    if (!r && action === 'undo') setUndone(true);
  };
  return (
    <div className={`chat-tool ${state}`}>
      <div className="chat-tool-line">
        <span className="chat-tool-dot" />
        <button className="chat-tool-text" title={state === 'failed' ? 'It didn’t work: show why' : 'Show what came back'} onClick={() => setOpen((o) => !o)} disabled={!item.result?.text}>
          {line}
          {state === 'failed' ? ' (didn’t work)' : ''}
          {undone ? ' (undone)' : ''}
        </button>
        {change && !undone && (
          <>
            <button className="outline small" title="Scroll to this change in the note and highlight it" onClick={() => void act('show')}>Show</button>
            <button className="outline small" title="Take back just this change, keeping anything typed since" onClick={() => void act('undo')}>Undo</button>
          </>
        )}
      </div>
      {msg && <div className="chat-tool-msg">{msg}</div>}
      {open && item.result?.text && <pre className="chat-tool-out">{item.result.text.replace(/\n?\(Locus change c\d+\)\s*$/, '')}</pre>}
    </div>
  );
}

function AskCard({ item, onAnswer }: { item: Extract<ChatItem, { t: 'ask' }>; onAnswer(a: ChatAnswer): void }) {
  const what = askLine(item);
  if (item.answer) {
    // A plain yes needs no line: what Claude then did shows as its own line.
    if (item.answer === 'allow') return null;
    const said = item.answer === 'deny' ? 'You said no to' : item.answer === 'cancelled' ? 'Not asked any more:' : item.answer === 'always' ? 'Allowed for this chat:' : 'Allowed:';
    return <div className={`chat-asked ${item.answer}`}>{said} {what}</div>;
  }
  return (
    <div className="chat-ask" role="group" aria-label="Claude asks">
      <div className="chat-ask-title">Allow Claude to {what}?</div>
      <div className="chat-ask-body">
        <AskBody item={item} />
      </div>
      <div className="chat-ask-actions">
        <button className="primary small" onClick={() => onAnswer('allow')} title="Let Claude do this once">Allow</button>
        <button className="outline small" onClick={() => onAnswer('always')} title={`Let Claude ${toolName(item.tool) === 'Bash' ? 'run commands' : 'do this kind of thing'} without asking until you start a new chat`}>Allow for this chat</button>
        <button className="outline small" onClick={() => onAnswer('deny')} title="Don’t do it; Claude is told you said no">Deny</button>
      </div>
    </div>
  );
}

const STARTERS = [
  { label: 'What am I looking at?', prompt: 'Look at what I have open in the viewer and tell me briefly what it shows.' },
  { label: 'Cite my selection', prompt: 'Cite what I have selected in the viewer in my note, with a sentence saying what it shows.' },
  { label: 'Check my note', prompt: 'Read my open note and point out claims that have no citation yet.' },
];

export function ChatView({
  visible,
  workspace,
  chip,
  onLink,
  onChange,
  onOpenTerminal,
  onSetup,
  onHideSetup,
  needsSetup,
}: {
  visible: boolean;
  workspace: string;
  chip: PanelChip | null;
  /** Opens a Locus link Claude wrote. */
  onLink(link: string): void;
  /** Show or Undo a change Claude made; a message when it can't. */
  onChange(id: string, action: 'show' | 'undo'): Promise<string | null>;
  onOpenTerminal(): void;
  onSetup(): void;
  onHideSetup(): void;
  needsSetup: boolean;
}) {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [partial, setPartial] = useState('');
  const [model, setModel] = useState<string | undefined>();
  const [draft, setDraft] = useState('');
  const [startError, setStartError] = useState<Exclude<ChatStart, { ok: true }> | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const pinned = useRef(true);

  const apply = (ev: ChatEvent) => {
    if (ev.reset) setItems(ev.items ?? []);
    if (ev.upsert) {
      const it = ev.upsert;
      setItems((xs) => {
        const i = xs.findIndex((x) => x.id === it.id);
        if (i < 0) return [...xs, it];
        const next = xs.slice();
        next[i] = it;
        return next;
      });
    }
    if (ev.busy !== undefined) setBusy(ev.busy);
    if (ev.partial !== undefined) setPartial(ev.partial);
    if (ev.model !== undefined) setModel(ev.model);
  };

  useEffect(() => {
    const off = events()?.onChatEvent?.(apply);
    return () => off?.();
  }, []);

  // The conversation so far, when the panel first shows for a workspace (or after a reload).
  useEffect(() => {
    void api.chatState().then((s) => {
      setItems([]);
      setPartial('');
      setBusy(false);
      setModel(undefined);
      apply(s);
    });
  }, [workspace]);

  useEffect(() => {
    if (visible) requestAnimationFrame(() => input.current?.focus());
  }, [visible]);

  // Keep to the newest message unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [items, partial, busy]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setDraft('');
    setStartError(null);
    pinned.current = true;
    const r = await api.chatSend(t).catch((e) => ({ ok: false as const, reason: 'failed' as const, message: String(e) }));
    if (!r.ok) {
      setStartError(r);
      setDraft(t);
    }
  };

  const addChip = () => {
    if (!chip) return;
    const el = input.current;
    const at = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, at);
    const piece = `${before && !/\s$/.test(before) ? ' ' : ''}${chip.link} `;
    setDraft(before + piece + draft.slice(at));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + piece.length, at + piece.length);
    });
  };

  const waiting = items.some((x) => x.t === 'ask' && !x.answer);
  const runningTool = busy && !partial ? [...items].reverse().find((x) => x.t === 'tool' && !x.result) : undefined;

  return (
    <div className="chat">
      {needsSetup && (
        <div className="claude-note">
          <div className="notice-body">
            <div>Claude Code doesn't have the Locus tools yet.</div>
            <div className="notice-help">The chat brings them along, so Claude can already make reference links here. Set up adds them to Claude Code everywhere else too.</div>
          </div>
          <button className="outline" onClick={onSetup}>Set up</button>
          <button className="icon" title="Hide this" onClick={onHideSetup}><Icon name="x" /></button>
        </div>
      )}
      <div
        className="chat-list"
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!items.length && !busy && (
          <div className="chat-empty">
            <p>Ask Claude about what you have open. It can see your note and the document beside it, open places, and change your note, asking you first.</p>
            <p className="chat-muted">This is your own Claude Code, signed in with your account. Locus never sees your sign-in.</p>
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s.label} className="outline small" title={s.prompt} onClick={() => void send(s.prompt)}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {items.map((it) => {
          if (it.t === 'user') return <div key={it.id} className="chat-user">{it.text}</div>;
          if (it.t === 'text') return <div key={it.id} className="chat-claude"><ChatText text={it.text} onLink={onLink} /></div>;
          if (it.t === 'tool') return <ToolRow key={it.id} item={it} onChange={onChange} />;
          if (it.t === 'ask') return <AskCard key={it.id} item={it} onAnswer={(a) => void api.chatAnswer(it.id, a)} />;
          if (it.kind === 'stopped') return <div key={it.id} className="chat-asked">Stopped.</div>;
          return (
            <div key={it.id} className={`chat-problem ${it.kind}`}>
              {it.kind === 'signin' ? (
                <>
                  <strong>Claude Code needs you to sign in.</strong>
                  <p>Locus uses your own Claude Code and never handles your sign-in. Open the terminal, type <code>/login</code> and follow the steps, then come back here and send your message again.</p>
                </>
              ) : (
                <>
                  <strong>Claude Code ran into a problem.</strong>
                  <p>The terminal runs the same Claude Code, so it can show more about what went wrong.</p>
                </>
              )}
              <pre className="chat-tool-out">{it.text}</pre>
              <button className="outline small" onClick={onOpenTerminal}>Open the terminal</button>
            </div>
          );
        })}
        {partial && <div className="chat-claude streaming"><ChatText text={partial} onLink={onLink} /></div>}
        {busy && !partial && !waiting && (
          <div className="chat-working">
            <span className="chat-dots"><i /><i /><i /></span> {runningTool && runningTool.t === 'tool' ? (toolLine(runningTool.name, runningTool.input as Record<string, unknown>) ?? 'Working') + '…' : 'Working…'}
          </div>
        )}
        {waiting && <div className="chat-working">Waiting for your answer above.</div>}
      </div>

      {startError && (
        <div className="chat-problem error">
          {startError.reason === 'no-claude' ? (
            <>
              <strong>Claude Code isn't installed.</strong>
              <p>
                The chat runs Claude Code, Anthropic's Claude for your computer, signed in with your own account. To install it, run <code>irm https://claude.ai/install.ps1 | iex</code> in PowerShell (or{' '}
                <code>winget install Anthropic.ClaudeCode</code>), then run <code>claude</code> once to sign in. Instructions: code.claude.com/docs/en/setup
              </p>
            </>
          ) : (
            <>
              <strong>{startError.reason === 'no-workspace' ? 'Open a workspace first.' : "Claude Code couldn't start."}</strong>
              <p>{startError.reason === 'no-workspace' ? 'Claude works in the workspace folder, so it starts once one is open.' : startError.message}</p>
            </>
          )}
          <button className="outline small" onClick={onOpenTerminal}>Open the terminal</button>
        </div>
      )}

      <div className="chat-compose">
        {chip && (
          <div className="chat-chip-row">
            <span className="claude-chip" title={chip.link}>
              <Icon name="link" size={13} /> {chip.label}
            </span>
            <span className="chat-muted">{chip.kind === 'selected' ? 'selected' : 'in view'}</span>
            <button className="outline small" title="Puts a link to this place into your message" onClick={addChip}>
              Add
            </button>
          </div>
        )}
        <textarea
          ref={input}
          className="chat-input"
          rows={2}
          placeholder={busy ? 'Claude is working… (Stop to interrupt)' : 'Ask Claude… (Enter sends, Shift+Enter for a new line)'}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(draft);
            } else if (e.key === 'Escape' && busy) {
              e.preventDefault();
              void api.chatInterrupt();
            }
          }}
        />
        <div className="chat-compose-row">
          <span className="chat-muted chat-model" title="The model your Claude Code is using">{model ?? ''}</span>
          <div className="spacer" />
          {busy ? (
            <button className="outline small" title="Stop what Claude is doing (Esc)" onClick={() => void api.chatInterrupt()}>Stop</button>
          ) : (
            <button className="primary small" title="Send (Enter)" disabled={!draft.trim()} onClick={() => void send(draft)}>Send</button>
          )}
        </div>
      </div>
    </div>
  );
}
