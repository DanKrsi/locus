import { useEffect, useState } from 'react';
import { basename } from '../../core/link';
import type { Terminology, Version } from '../../shared/api';
import { api } from '../api';
import { loadBytes } from '../files';
import { Icon, kindIcon } from '../icons';
import type { DocTab } from '../model';
import { term, versionBadge, longDate } from '../terms';
import { CodeViewer } from '../viewers/CodeViewer';
import { ImageViewer, MediaViewer, UnsupportedViewer } from '../viewers/OtherViewers';
import { PdfViewer } from '../viewers/PdfViewer';
import { SheetViewer } from '../viewers/SheetViewer';
import type { ViewerHandle } from '../viewers/types';

interface Props {
  tabs: DocTab[];
  activeId: string | null;
  terminology: Terminology;
  /** Bumped whenever versions change so strips reload. */
  versionsKey: number;
  /** SHAs cited by the active note, per path, for gold dots on the strip. */
  citedRevs: Map<string, Set<string>>;
  onActivate(id: string): void;
  onClose(id: string): void;
  onOpen(): void;
  onCite(tab: DocTab): void;
  onChangeRev(tab: DocTab, rev: string | undefined): void;
  registerHandle(id: string, h: ViewerHandle | null): void;
}

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
            <Icon name={kindIcon(t.kind)} size={14} />
            <span className="title">{basename(t.path)}</span>
            {t.rev && <RevBadge rev={t.rev} terminology={p.terminology} />}
            {t.external && <span className="badge muted">external</span>}
            <span className="close" onMouseDown={(e) => { e.stopPropagation(); p.onClose(t.id); }}><Icon name="x" size={12} /></span>
          </div>
        ))}
        <button className="tab-add" onClick={p.onOpen}><Icon name="plus" size={14} /> Open</button>
      </div>
      {p.tabs.length === 0 && (
        <div className="empty">
          <h3>No document open</h3>
          <div>Open PDFs, code, spreadsheets, images or recordings to cite them in your notes.</div>
          <button className="primary" onClick={p.onOpen}><Icon name="folderOpen" /> Open file</button>
          <div className="muted" style={{ fontSize: 12 }}>Ctrl+P to find a file by name</div>
        </div>
      )}
      {p.tabs.map((t) => (
        <DocView key={t.id} tab={t} visible={t.id === p.activeId} {...p} />
      ))}
    </div>
  );
}

const versionDates = new Map<string, string>();

function RevBadge({ rev, terminology }: { rev: string; terminology: Terminology }) {
  return <span className="badge mark">{versionBadge(terminology, rev, versionDates.get(rev))}</span>;
}

function DocView({ tab, visible, ...p }: Props & { tab: DocTab; visible: boolean }) {
  const [data, setData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    loadBytes({ path: tab.path, external: tab.external, rev: tab.rev })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [tab.path, tab.rev, tab.external]);

  const strip = !tab.external && (
    <VersionStrip tab={tab} terminology={p.terminology} versionsKey={p.versionsKey} cited={p.citedRevs.get(tab.path)} onPick={(rev) => p.onChangeRev(tab, rev)} />
  );

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="empty">
        <h3>Couldn't open {basename(tab.path)}</h3>
        <div>{error}</div>
      </div>
    );
  } else if (!data) {
    body = <div className="empty">Loading {basename(tab.path)}…</div>;
  } else {
    const props = {
      data,
      path: tab.path,
      reveal: tab.reveal,
      onCite: () => p.onCite(tab),
      handle: (h: ViewerHandle | null) => p.registerHandle(tab.id, h),
    };
    switch (tab.kind) {
      case 'pdf':
        body = <PdfViewer {...props} />;
        break;
      case 'sheet':
        body = <SheetViewer {...props} />;
        break;
      case 'image':
        body = <ImageViewer {...props} />;
        break;
      case 'media':
        body = <MediaViewer {...props} />;
        break;
      case 'code':
      case 'markdown':
        body = <CodeViewer {...props} />;
        break;
      default:
        body = <UnsupportedViewer path={tab.path} onOpenExternally={() => api.openExternally(tab.path)} />;
    }
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
  onPick,
}: {
  tab: DocTab;
  terminology: Terminology;
  versionsKey: number;
  cited?: Set<string>;
  onPick(rev: string | undefined): void;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  useEffect(() => {
    api.versions(tab.path).then((v) => {
      for (const x of v) versionDates.set(x.sha, x.date);
      setVersions(v.slice().reverse());
    }, () => setVersions([]));
  }, [tab.path, versionsKey]);
  if (versions.length === 0) return null;
  const n = versions.length;
  const pos = (i: number) => (n === 0 ? 100 : (i / n) * 100);
  const isCited = (sha: string) => [...(cited ?? [])].some((c) => sha.startsWith(c));
  return (
    <div className="vstrip">
      <span>{term(terminology, 'history')}</span>
      <div className="track">
        <div className="line" />
        {versions.map((v, i) => (
          <button
            key={v.sha}
            className={'vdot' + (isCited(v.sha) ? ' cited' : '') + (tab.rev === v.sha ? ' current' : '')}
            style={{ left: `${pos(i)}%` }}
            title={`${terminology === 'git' ? v.sha.slice(0, 7) + ' · ' : ''}${longDate(v.date)}\n${v.message}`}
            onClick={() => onPick(v.sha)}
          />
        ))}
        <button className={'vdot' + (!tab.rev ? ' current' : '')} style={{ left: '100%' }} title={term(terminology, 'latest')} onClick={() => onPick(undefined)} />
      </div>
      <span>{term(terminology, 'latest')}</span>
    </div>
  );
}

export { versionDates };
