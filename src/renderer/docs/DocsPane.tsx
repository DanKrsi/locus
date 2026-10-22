import { useEffect, useMemo, useState } from 'react';
import { basename, parseDestination, type FileKind } from '../../core/link';
import type { Citation, Terminology, Version } from '../../shared/api';
import { api } from '../api';
import { loadBytes } from '../files';
import { Icon, kindIcon } from '../icons';
import type { DocTab } from '../model';
import { term, versionBadge, longDate } from '../terms';
import { CodeViewer } from '../viewers/CodeViewer';
import { DiffViewer } from '../viewers/DiffViewer';
import { ImageViewer, MediaViewer, UnsupportedViewer } from '../viewers/OtherViewers';
import { PdfViewer } from '../viewers/PdfViewer';
import { SheetViewer } from '../viewers/SheetViewer';
import { SlidesViewer } from '../viewers/SlidesViewer';
import type { CiteMark, RevealRequest, ViewerHandle } from '../viewers/types';

interface Props {
  tabs: DocTab[];
  activeId: string | null;
  terminology: Terminology;
  /** Bumped whenever versions change so strips reload. */
  versionsKey: number;
  /** SHAs cited by the active note, per path, for gold dots on the strip. */
  citedRevs: Map<string, Set<string>>;
  /** Every reference in the workspace's notes. */
  citations: Citation[];
  onActivate(id: string): void;
  onClose(id: string): void;
  onOpen(): void;
  onCite(tab: DocTab): void;
  onChangeRev(tab: DocTab, rev: string | undefined): void;
  /** Starts or changes a comparison (left side = `rev`); undefined ends it. */
  onCompare(tab: DocTab, rev: string | undefined): void;
  onOpenCitation(c: { note: string; line: number }): void;
  registerHandle(id: string, h: ViewerHandle | null): void;
  /** Date of a version, from a full or short SHA. */
  versionDate(sha: string): string | undefined;
}

const sameRev = (a?: string, b?: string) => (!a && !b) || (!!a && !!b && (a.startsWith(b) || b.startsWith(a)));

export function DocsPane(p: Props) {
  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="tabs">
        {p.tabs.map((t) => (
          <div
            key={t.id}
            className={'tab' + (t.id === p.activeId ? ' active' : '')}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                p.onClose(t.id);
              } else p.onActivate(t.id);
            }}
            title={t.path}
          >
            <Icon name={t.compare ? 'compare' : kindIcon(t.kind)} size={14} />
            <span className="title">{basename(t.path)}</span>
            {t.rev && <span className="badge mark">{versionBadge(p.terminology, t.rev, p.versionDate(t.rev))}</span>}
            {t.external && <span className="badge muted">external</span>}
            <span className="close" onMouseDown={(e) => { e.stopPropagation(); p.onClose(t.id); }}><Icon name="x" size={12} /></span>
          </div>
        ))}
        <button className="tab-add" title="Open a document in the viewer (Ctrl+P)" onClick={p.onOpen}><Icon name="plus" size={14} /> Open document</button>
      </div>
      {p.tabs.length === 0 && (
        <div className="empty">
          <h3>No document open</h3>
          <div>Open PDFs, code, spreadsheets, images or recordings to cite them in your notes.</div>
          <button className="primary" onClick={p.onOpen}><Icon name="folderOpen" /> Open document</button>
          <div className="muted" style={{ fontSize: 12 }}>Ctrl+P to find a file by name</div>
        </div>
      )}
      {p.tabs.map((t) => (
        <DocView key={t.id} tab={t} visible={t.id === p.activeId} {...p} />
      ))}
    </div>
  );
}

function useBytes(path: string, external: boolean, rev?: string, enabled = true) {
  const [data, setData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setData(null);
    setError(null);
    loadBytes({ path, external, rev })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [path, rev, external, enabled]);
  return { data, error };
}

/** Citations of this file that point at the version being shown. */
function marksFor(citations: Citation[], path: string, rev?: string): CiteMark[] {
  const out: CiteMark[] = [];
  for (const c of citations) {
    if (c.path !== path) continue;
    const ref = parseDestination(c.dest);
    if (!ref || !sameRev(ref.rev, rev)) continue;
    const loc = c.lines && !rev ? { ...ref.loc, lines: c.lines } : ref.loc;
    out.push({ loc, label: c.label, note: c.note, line: c.line });
  }
  return out;
}

interface BodyProps {
  kind: FileKind;
  path: string;
  data: Uint8Array;
  reveal?: RevealRequest;
  marks?: CiteMark[];
  onMark?(m: CiteMark): void;
  onCite(): void;
  handle(h: ViewerHandle | null): void;
}

function ViewerBody({ kind, ...props }: BodyProps) {
  switch (kind) {
    case 'pdf':
      return <PdfViewer {...props} />;
    case 'sheet':
      return <SheetViewer {...props} />;
    case 'image':
      return <ImageViewer {...props} />;
    case 'media':
      return <MediaViewer {...props} />;
    case 'slides':
      return <SlidesViewer {...props} />;
    case 'code':
    case 'markdown':
      return <CodeViewer {...props} />;
    default:
      return <UnsupportedViewer path={props.path} onOpenExternally={() => api.openExternally(props.path)} />;
  }
}

function DocView({ tab, visible, ...p }: Props & { tab: DocTab; visible: boolean }) {
  const main = useBytes(tab.path, tab.external, tab.rev);
  const left = useBytes(tab.path, tab.external, tab.compare, !!tab.compare);
  const marks = useMemo(() => marksFor(p.citations, tab.path, tab.rev), [p.citations, tab.path, tab.rev]);
  const allCites = useMemo(() => p.citations.filter((c) => c.path === tab.path), [p.citations, tab.path]);
  const onMark = (m: CiteMark) => p.onOpenCitation(m);
  const leftTab: DocTab = { ...tab, id: `${tab.id}:left`, rev: tab.compare, compare: undefined, reveal: undefined };

  const strip = !tab.external && (
    <VersionStrip
      tab={tab}
      terminology={p.terminology}
      versionsKey={p.versionsKey}
      cited={p.citedRevs.get(tab.path)}
      citations={allCites}
      onPick={(rev) => (tab.compare ? p.onCompare(tab, rev ?? tab.compare) : p.onChangeRev(tab, rev))}
      onCompare={(rev) => p.onCompare(tab, rev)}
      onOpenCitation={p.onOpenCitation}
      versionDate={p.versionDate}
    />
  );

  const label = (rev?: string) => (rev ? versionBadge(p.terminology, rev, p.versionDate(rev)) : term(p.terminology, 'latest'));
  const error = main.error ?? left.error;
  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="empty">
        <h3>Couldn't open {basename(tab.path)}</h3>
        <div>{error}</div>
      </div>
    );
  } else if (!main.data || (tab.compare && !left.data)) {
    body = <div className="empty">Loading {basename(tab.path)}…</div>;
  } else if (tab.compare && left.data) {
    const head = (
      <div className="compare-head">
        <Icon name="compare" /> Comparing {label(tab.compare)} with {label(tab.rev)}
        <div className="spacer" />
        <button className="outline" onClick={() => p.onCompare(tab, undefined)}>Stop comparing</button>
      </div>
    );
    body =
      tab.kind === 'code' || tab.kind === 'markdown' ? (
        <div className="compare-wrap">
          {head}
          <DiffViewer left={left.data} right={main.data} path={tab.path} />
        </div>
      ) : (
        <div className="compare-wrap">
          {head}
          <div className="compare-split">
            <div className="side">
              <ViewerBody
                kind={tab.kind}
                path={tab.path}
                data={left.data}
                marks={marksFor(p.citations, tab.path, tab.compare)}
                onMark={onMark}
                onCite={() => p.onCite(leftTab)}
                handle={(h) => p.registerHandle(leftTab.id, h)}
              />
            </div>
            <div className="side">
              <ViewerBody
                kind={tab.kind}
                path={tab.path}
                data={main.data}
                marks={marks}
                onMark={onMark}
                reveal={tab.reveal}
                onCite={() => p.onCite(tab)}
                handle={(h) => p.registerHandle(tab.id, h)}
              />
            </div>
          </div>
        </div>
      );
  } else {
    body = (
      <ViewerBody
        kind={tab.kind}
        path={tab.path}
        data={main.data}
        reveal={tab.reveal}
        marks={marks}
        onMark={onMark}
        onCite={() => p.onCite(tab)}
        handle={(h) => p.registerHandle(tab.id, h)}
      />
    );
  }

  return (
    <div className={'viewer' + (visible ? '' : ' hidden')}>
      {body}
      {strip}
    </div>
  );
}

function VersionStrip({
  tab,
  terminology,
  versionsKey,
  cited,
  citations,
  onPick,
  onCompare,
  onOpenCitation,
  versionDate,
}: {
  tab: DocTab;
  terminology: Terminology;
  versionsKey: number;
  cited?: Set<string>;
  citations: Citation[];
  onPick(rev: string | undefined): void;
  onCompare(rev: string | undefined): void;
  onOpenCitation(c: Citation): void;
  versionDate(sha: string): string | undefined;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [showCites, setShowCites] = useState(false);
  useEffect(() => {
    api.versions(tab.path).then((v) => setVersions(v.slice().reverse()), () => setVersions([]));
  }, [tab.path, versionsKey]);
  useEffect(() => {
    if (!showCites) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest('.cite-list, .strip-btn') && setShowCites(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [showCites]);
  if (versions.length === 0 && citations.length === 0) return null;
  const n = versions.length;
  const pos = (i: number) => (n === 0 ? 100 : (i / n) * 100);
  const isCited = (sha: string) => [...(cited ?? [])].some((c) => sha.startsWith(c));
  // When comparing, the strip edits the left side; otherwise it switches the shown version.
  const startCompare = () => {
    const current = tab.rev ? versions.findIndex((v) => v.sha.startsWith(tab.rev!)) : versions.length;
    const before = versions[Math.max(0, current - 1)];
    if (before) onCompare(before.sha);
  };
  const notes = new Set(citations.map((c) => c.note)).size;
  return (
    <div className="vstrip" style={{ position: 'relative' }}>
      <span>{term(terminology, 'history')}</span>
      <div className="track">
        <div className="line" />
        {versions.map((v, i) => (
          <button
            key={v.sha}
            className={
              'vdot' +
              (isCited(v.sha) ? ' cited' : '') +
              (tab.rev && v.sha.startsWith(tab.rev) ? ' current' : '') +
              (tab.compare && v.sha.startsWith(tab.compare) ? ' compare' : '')
            }
            style={{ left: `${pos(i)}%` }}
            title={`${terminology === 'git' ? v.sha.slice(0, 7) + ' · ' : ''}${longDate(v.date)}\n${v.message}${tab.compare ? '\nClick to compare against this version' : ''}`}
            onClick={() => onPick(v.sha)}
          />
        ))}
        <button className={'vdot' + (!tab.rev ? ' current' : '')} style={{ left: '100%' }} title={term(terminology, 'latest')} onClick={() => onPick(undefined)} />
      </div>
      <span>{term(terminology, 'latest')}</span>
      {versions.length > 0 && (
        <button
          className={'strip-btn' + (tab.compare ? ' on' : '')}
          title="Compare two versions side by side"
          onClick={() => (tab.compare ? onCompare(undefined) : startCompare())}
        >
          <Icon name="compare" size={12} /> Compare
        </button>
      )}
      {citations.length > 0 && (
        <button className={'strip-btn' + (showCites ? ' on' : '')} title="Notes that cite this file" onClick={() => setShowCites(!showCites)}>
          <Icon name="bookmark" size={12} /> Cited in {notes} {notes === 1 ? 'note' : 'notes'}
        </button>
      )}
      {showCites && (
        <div className="popover cite-list" style={{ top: 24, right: 8 }}>
          {citations.map((c, i) => {
            const ref = parseDestination(c.dest);
            const pinned = ref?.rev ? ` · ${versionBadge(terminology, ref.rev, versionDate(ref.rev))}` : '';
            return (
              <button
                key={i}
                className="menu-item"
                onClick={() => {
                  setShowCites(false);
                  onOpenCitation(c);
                }}
              >
                <span><Icon name="bookmark" size={12} /> {c.label}</span>
                <span className="where">{basename(c.note)} · line {c.line}{pinned}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
