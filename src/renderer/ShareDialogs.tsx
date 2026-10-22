// Sharing UI (UI spec §7): Share dialog, GitHub sign-in, conflicts, and opening shared work.
import { useEffect, useState } from 'react';
import { basename, fileKind } from '../core/link';
import type { GitHubAccount, Invitation, Person, RepoSummary, SharingInfo, SyncResult, Terminology, WorkspaceInfo } from '../shared/api';
import { api } from './api';
import { decodeText } from './files';
import { Icon } from './icons';
import { longDate, term } from './terms';

/** Shows only the part of two texts that differs, with a little context around it. */
export function differingPart(a: string, b: string, context = 2): { a: string; b: string; from: number } {
  const la = a.split(/\r?\n/);
  const lb = b.split(/\r?\n/);
  let start = 0;
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++;
  let endA = la.length - 1;
  let endB = lb.length - 1;
  while (endA >= start && endB >= start && la[endA] === lb[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const cut = (lines: string[], end: number) => {
    const to = Math.min(lines.length - 1, end + context);
    return (from > 0 ? '…\n' : '') + lines.slice(from, to + 1).join('\n') + (to < lines.length - 1 ? '\n…' : '');
  };
  return { a: cut(la, endA), b: cut(lb, endB), from: from + 1 };
}

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method 'api': (Error: )?/, '');

function Dialog({ title, width = 560, onClose, children, foot }: { title: React.ReactNode; width?: number; onClose(): void; children: React.ReactNode; foot?: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="locus-dialog" style={{ width }}>
        <div className="dialog-head"><h2>{title}</h2></div>
        <div className="dialog-body share-body">{children}</div>
        {foot && <div className="dialog-foot">{foot}</div>}
      </div>
    </div>
  );
}

/** GitHub device-flow sign-in: shows the one-time code while the browser does the rest. */
export function SignIn({ onDone }: { onDone(a: GitHubAccount): void }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setError(null);
    try {
      const c = await api.githubSignInStart();
      setCode(c.userCode);
      onDone(await api.githubSignInWait());
    } catch (e) {
      setCode(null);
      setError(errText(e));
    }
  };
  if (code) {
    return (
      <div className="share-step">
        <div><b>Your browser opened github.com.</b> Check this code matches, then click Authorize.</div>
        <div className="device-code">{code}</div>
        <div className="muted"><Icon name="clock" size={14} /> Waiting for approval… This is only needed once per computer.</div>
        <button className="outline" onClick={() => api.copyText(code)}><Icon name="copy" size={14} /> Copy code</button>
      </div>
    );
  }
  return (
    <div className="share-step">
      <button className="primary" onClick={() => void start()}><Icon name="github" /> Sign in with GitHub</button>
      <div className="muted" style={{ fontSize: 12.5 }}>
        No account? <a href="https://github.com/signup" target="_blank" rel="noreferrer">Create one free</a>
      </div>
      {error && <div className="error-text">{error}</div>}
    </div>
  );
}

export function ShareDialog({
  ws,
  terminology,
  onClose,
  onShared,
  toast,
}: {
  ws: WorkspaceInfo;
  terminology: Terminology;
  onClose(): void;
  onShared(): void;
  toast(msg: string): void;
}) {
  const [info, setInfo] = useState<SharingInfo | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [invitee, setInvitee] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const i = await api.sharingStatus(false);
    setInfo(i);
    if (i.github && i.account) setPeople(await api.githubPeople().catch(() => []));
  };
  useEffect(() => {
    void refresh();
  }, []);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const openLink = info?.github ? `locus://open?repo=${info.github.owner}/${info.github.repo}` : '';

  return (
    <Dialog
      title={<>Share “{ws.name}”</>}
      onClose={onClose}
      foot={
        <>
          {info?.account && (
            <span className="muted" style={{ fontSize: 12.5, marginRight: 'auto' }}>
              Signed in as <b>{info.account.login}</b> ·{' '}
              <a href="#" onClick={(e) => (e.preventDefault(), void api.githubSignOut().then(refresh))}>Sign out</a>
            </span>
          )}
          <button className="outline" onClick={onClose}>Done</button>
        </>
      }
    >
      <section>
        <h3><Icon name="cloud" /> {terminology === 'git' ? 'Push to GitHub' : 'Share online'}</h3>
        {!info && <div className="muted">Checking…</div>}
        {info && !info.canSignIn && !info.remote && (
          <div className="muted">GitHub sign-in isn't set up in this build yet. You can still send the workspace as a file below.</div>
        )}
        {info && info.canSignIn && !info.account && (
          <>
            <p className="muted">Keep a private online copy so others can open it and stay in sync.</p>
            <SignIn onDone={() => void refresh()} />
          </>
        )}
        {info?.account && !info.github && !info.remote && (
          <>
            <p className="muted">Creates a private repository on your GitHub account with this workspace and its full version history.</p>
            <button
              className="primary"
              disabled={!!busy}
              onClick={() =>
                run('share', async () => {
                  await api.githubShare();
                  await refresh();
                  onShared();
                  toast('Shared privately on GitHub');
                })
              }
            >
              <Icon name="lock" /> {busy === 'share' ? 'Uploading…' : 'Create a private online copy'}
            </button>
          </>
        )}
        {info?.remote && !info.github && (
          <div className="muted">This workspace syncs with <span className="mono">{info.remote}</span>.</div>
        )}
        {info?.github && (
          <>
            <div className="shared-line">
              <Icon name="lock" /> Shared privately as{' '}
              <a href={`https://github.com/${info.github.owner}/${info.github.repo}`} target="_blank" rel="noreferrer">
                {info.github.owner}/{info.github.repo}
              </a>
            </div>
            {info.account && (
              <>
                <div className="invite-row">
                  <input
                    placeholder="GitHub username"
                    value={invitee}
                    onChange={(e) => setInvitee(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && invitee.trim() && document.getElementById('invite-btn')?.click()}
                  />
                  <button
                    id="invite-btn"
                    className="primary"
                    disabled={!invitee.trim() || !!busy}
                    onClick={() =>
                      run('invite', async () => {
                        const r = await api.githubInvite(invitee.trim());
                        toast(r === 'invited' ? `Invitation sent to ${invitee.trim()}` : `${invitee.trim()} already has access`);
                        setInvitee('');
                        setPeople(await api.githubPeople().catch(() => people));
                      })
                    }
                  >
                    Invite
                  </button>
                </div>
                <div className="muted" style={{ fontSize: 12 }}>GitHub emails them an invitation. They need a free GitHub account.</div>
                <div className="people">
                  {people.map((p) => (
                    <div key={p.login} className="person">
                      <span>{p.login === info.account?.login ? 'You' : p.login}</span>
                      <span className="muted">{p.status === 'owner' ? 'Owner' : p.status === 'member' ? 'Can edit' : 'Invite sent'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <button
              className="outline"
              onClick={() => {
                void api.copyText(openLink);
                toast('Open link copied');
              }}
              title={openLink}
            >
              <Icon name="link" /> Copy open link
            </button>
          </>
        )}
      </section>

      <section>
        <h3><Icon name="package" /> {term(terminology, 'shareAsFile')}</h3>
        <p className="muted">One file with everything, including version history. Email it, send it on Teams, or put it on a shared drive. No account needed.</p>
        <button
          className="outline"
          disabled={!!busy}
          onClick={() =>
            run('file', async () => {
              const file = await api.exportPackage();
              if (file) toast(`Saved ${basename(file.replace(/\\/g, '/'))}`);
            })
          }
        >
          <Icon name="download" /> {busy === 'file' ? 'Packing…' : 'Save as a file…'}
        </button>
      </section>
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}

/** Shown when a sync finds the same file changed in two places. */
export function ConflictDialog({
  files,
  terminology,
  onResolved,
  onCancel,
}: {
  files: string[];
  terminology: Terminology;
  onResolved(r: SyncResult): void;
  onCancel(): void;
}) {
  const [remaining, setRemaining] = useState(files);
  const [current, setCurrent] = useState(files[0]);
  const [sides, setSides] = useState<{ mine: string | null; theirs: string | null; author: string; binary: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!current) return;
    setSides(null);
    api.conflictSides(current).then((s) => {
      const kind = fileKind(current);
      const binary = !(kind === 'code' || kind === 'markdown');
      setSides({
        mine: s.mine ? (binary ? null : decodeText(s.mine).text) : null,
        theirs: s.theirs ? (binary ? null : decodeText(s.theirs).text) : null,
        author: s.theirsAuthor,
        binary,
      });
    });
  }, [current]);

  const choose = async (choice: 'mine' | 'theirs' | 'both') => {
    try {
      await api.resolveConflict(current, choice);
      const rest = remaining.filter((f) => f !== current);
      setRemaining(rest);
      if (rest.length) setCurrent(rest[0]);
      else onResolved(await api.finishSync());
    } catch (e) {
      setError(errText(e));
    }
  };

  const who = sides?.author && sides.author !== 'their' ? sides.author : 'Someone else';
  return (
    <Dialog
      title={<>Changed in two places · {remaining.length} {remaining.length === 1 ? 'file' : 'files'} left</>}
      width={920}
      onClose={onCancel}
      foot={
        <>
          <button className="outline" style={{ marginRight: 'auto' }} onClick={onCancel}>
            {terminology === 'git' ? 'Abort merge' : 'Stop and keep things as they were'}
          </button>
          <button className="outline" onClick={() => void choose('mine')}>Keep mine</button>
          <button className="outline" onClick={() => void choose('theirs')}>Keep theirs</button>
          <button className="primary" onClick={() => void choose('both')}>Keep both</button>
        </>
      }
    >
      <p>
        <b>{current?.slice(1)}</b> was changed both here and by {who}.{' '}
        {sides?.binary ? 'It can’t be merged automatically. “Keep both” saves their version next to yours.' : 'Pick which version to keep, or keep both as separate files.'}
      </p>
      {sides && !sides.binary && (() => {
        const part = sides.mine !== null && sides.theirs !== null ? differingPart(sides.mine, sides.theirs) : null;
        return (
          <>
            {part && <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>Showing the part that differs, from line {part.from}.</div>}
            <div className="conflict-sides">
              <div>
                <div className="side-label">Yours</div>
                <pre>{part ? part.a : sides.mine ?? '(deleted)'}</pre>
              </div>
              <div>
                <div className="side-label">{who}’s</div>
                <pre>{part ? part.b : sides.theirs ?? '(deleted)'}</pre>
              </div>
            </div>
          </>
        );
      })()}
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}

/** "Download from GitHub": invitations and repositories the signed-in person can open. */
export function GitHubOpenDialog({
  initialRepo,
  onOpened,
  onClose,
}: {
  initialRepo?: string;
  onOpened(w: WorkspaceInfo): void;
  onClose(): void;
}) {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [canSignIn, setCanSignIn] = useState(true);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api.githubRepos();
      setRepos(r.repos);
      setInvites(r.invitations);
      setSignedIn(true);
      if (initialRepo) await open(initialRepo, r.invitations.find((i) => i.fullName.toLowerCase() === initialRepo.toLowerCase()));
    } catch (e) {
      const msg = errText(e);
      if (/sign in/i.test(msg)) setSignedIn(false);
      else setError(msg);
    }
  };

  useEffect(() => {
    // sharingStatus needs an open workspace; probe sign-in through the repo list instead.
    api.githubRepos().then(
      () => void load(),
      (e) => {
        setSignedIn(false);
        if (/not set up/i.test(errText(e))) setCanSignIn(false);
      },
    );
  }, []);

  const open = async (fullName: string, invite?: Invitation) => {
    setBusy(fullName);
    setError(null);
    try {
      if (invite) await api.githubAcceptInvitation(invite.id);
      const w = await api.githubClone(fullName);
      if (w) onOpened(w);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog title="Download a workspace from GitHub" width={600} onClose={onClose} foot={<button className="outline" onClick={onClose}>Cancel</button>}>
      {signedIn === false && (canSignIn ? <SignIn onDone={() => void load()} /> : <div className="muted">GitHub sign-in isn't set up in this build yet.</div>)}
      {busy && <div className="muted">Downloading {busy}…</div>}
      {invites.length > 0 && (
        <section>
          <h3>Invitations</h3>
          {invites.map((i) => (
            <div key={i.id} className="repo-row">
              <div>
                <b>{i.fullName}</b>
                <div className="muted" style={{ fontSize: 12 }}>from {i.inviter}</div>
              </div>
              <button className="primary" disabled={!!busy} onClick={() => void open(i.fullName, i)}>Accept and open</button>
            </div>
          ))}
        </section>
      )}
      {repos && (
        <section>
          <h3>Your repositories</h3>
          {repos.length === 0 && <div className="muted">Nothing here yet.</div>}
          {repos.map((r) => (
            <div key={r.fullName} className="repo-row clickable" onClick={() => !busy && void open(r.fullName)}>
              <div>
                <b>{r.fullName}</b> {r.private && <span className="badge muted">private</span>}
                <div className="muted" style={{ fontSize: 12 }}>{r.description || 'No description'} · updated {longDate(r.updated)}</div>
              </div>
              <Icon name="download" />
            </div>
          ))}
        </section>
      )}
      {error && <div className="error-text">{error}</div>}
    </Dialog>
  );
}
