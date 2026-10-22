// GitHub sign-in (device flow, no client secret needed) and the few REST calls sharing uses.
export const GITHUB_SCOPE = 'repo';

/** The OAuth app's public client ID (Settings → Developer settings → OAuth Apps, Device Flow enabled). */
export const GITHUB_CLIENT_ID = process.env.LOCUS_GITHUB_CLIENT_ID || '';

export class GitHubError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresAt: number;
}

async function form(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  return (await res.json()) as Record<string, string | number>;
}

export async function startDeviceFlow(clientId = GITHUB_CLIENT_ID): Promise<DeviceCode> {
  if (!clientId) throw new GitHubError('GitHub sign-in is not set up in this build (no OAuth client ID)');
  const r = await form('https://github.com/login/device/code', { client_id: clientId, scope: GITHUB_SCOPE });
  if (!r.device_code) throw new GitHubError(String(r.error_description ?? r.error ?? 'GitHub did not start sign-in'));
  return {
    deviceCode: String(r.device_code),
    userCode: String(r.user_code),
    verificationUri: String(r.verification_uri),
    interval: Number(r.interval ?? 5),
    expiresAt: Date.now() + Number(r.expires_in ?? 900) * 1000,
  };
}

/** Waits until the user approves the code in their browser; returns the access token. */
export async function pollDeviceFlow(code: DeviceCode, clientId = GITHUB_CLIENT_ID, signal?: AbortSignal): Promise<string> {
  let interval = code.interval;
  while (Date.now() < code.expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (signal?.aborted) throw new GitHubError('Sign-in cancelled');
    const r = await form('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (r.access_token) return String(r.access_token);
    if (r.error === 'authorization_pending') continue;
    if (r.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (r.error === 'access_denied') throw new GitHubError('Sign-in was declined in the browser');
    if (r.error === 'expired_token') break;
    throw new GitHubError(String(r.error_description ?? r.error));
  }
  throw new GitHubError('The sign-in code expired. Try again.');
}

async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errors = Array.isArray(body.errors) ? body.errors.map((e: { message?: string }) => e.message).filter(Boolean).join('; ') : '';
    throw new GitHubError(errors || String(body.message ?? res.statusText), res.status);
  }
  return body as T;
}

export interface GitHubUser {
  login: string;
  name: string;
  email: string;
}

export async function getUser(token: string): Promise<GitHubUser> {
  const u = await api<{ login: string; name: string | null; id: number }>(token, '/user');
  // The noreply address keeps people's real email out of shared history.
  return { login: u.login, name: u.name || u.login, email: `${u.id}+${u.login}@users.noreply.github.com` };
}

/** Repository names GitHub accepts, derived from a workspace name. */
export function repoName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90) || 'locus-workspace';
}

export async function createRepo(token: string, name: string, description: string): Promise<{ owner: string; repo: string; cloneUrl: string }> {
  const base = repoName(name);
  for (let i = 0; i < 20; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    try {
      const r = await api<{ name: string; owner: { login: string }; clone_url: string }>(token, '/user/repos', {
        method: 'POST',
        body: JSON.stringify({ name: candidate, description, private: true, auto_init: false }),
      });
      return { owner: r.owner.login, repo: r.name, cloneUrl: r.clone_url };
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422 && /already exists/i.test(e.message)) continue;
      throw e;
    }
  }
  throw new GitHubError('Could not find a free repository name');
}

export async function invite(token: string, owner: string, repo: string, username: string): Promise<'invited' | 'member'> {
  const r = await api<{ id?: number } | undefined>(token, `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username.replace(/^@/, ''))}`, {
    method: 'PUT',
    body: JSON.stringify({ permission: 'push' }),
  });
  return r ? 'invited' : 'member';
}

export interface Person {
  login: string;
  status: 'owner' | 'member' | 'invited';
}

export async function people(token: string, owner: string, repo: string): Promise<Person[]> {
  const members = await api<{ login: string; role_name?: string }[]>(token, `/repos/${owner}/${repo}/collaborators`);
  const invites = await api<{ invitee: { login: string } | null }[]>(token, `/repos/${owner}/${repo}/invitations`).catch(() => []);
  return [
    ...members.map((m) => ({ login: m.login, status: (m.login === owner ? 'owner' : 'member') as Person['status'] })),
    ...invites.filter((i) => i.invitee).map((i) => ({ login: i.invitee!.login, status: 'invited' as const })),
  ];
}

export interface RepoSummary {
  fullName: string;
  private: boolean;
  updated: string;
  description: string;
}

export interface Invitation {
  id: number;
  fullName: string;
  inviter: string;
}

/** Invitations to repositories waiting for this user's answer. */
export async function listInvitations(token: string): Promise<Invitation[]> {
  const pending = await api<{ id: number; repository: { full_name: string }; inviter: { login: string } | null }[]>(token, '/user/repository_invitations');
  return pending.map((p) => ({ id: p.id, fullName: p.repository.full_name, inviter: p.inviter?.login ?? '' }));
}

export async function acceptInvitation(token: string, id: number): Promise<void> {
  await api(token, `/user/repository_invitations/${id}`, { method: 'PATCH' });
}

export async function listRepos(token: string): Promise<RepoSummary[]> {
  const repos = await api<{ full_name: string; private: boolean; updated_at: string; description: string | null }[]>(
    token,
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator',
  );
  return repos.map((r) => ({ fullName: r.full_name, private: r.private, updated: r.updated_at, description: r.description ?? '' }));
}

/** Parses "https://github.com/owner/repo(.git)" into its parts. */
export function parseGitHubUrl(url: string | null): { owner: string; repo: string } | null {
  const m = url?.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}
