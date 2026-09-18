export interface GithubSettings {
  owner: string
  repo: string
  token: string
  eventType: string
}

export function parseRepo(input: string): { owner: string, repo: string } {
  const trimmed = input.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/, '')
  const [owner, repo] = trimmed.split('/')
  if (!owner || !repo) {
    throw new Error('Repo must look like owner/name')
  }
  return { owner, repo }
}

export async function dispatchPublish(settings: GithubSettings): Promise<void> {
  const url = `https://api.github.com/repos/${settings.owner}/${settings.repo}/dispatches`
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${settings.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: settings.eventType }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`GitHub dispatch failed (${response.status}): ${body || response.statusText}`)
  }
}

export function actionsUrl(settings: Pick<GithubSettings, 'owner' | 'repo'>): string {
  return `https://github.com/${settings.owner}/${settings.repo}/actions`
}
