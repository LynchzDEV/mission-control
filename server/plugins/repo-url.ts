const ALLOWED_REPO_URL = /^(?:https:\/\/[^\s]+|file:\/\/[^\s]+|git@[^\s:]+:[^\s]+)$/

export function isAllowedRepoUrl(url: string): boolean {
  return ALLOWED_REPO_URL.test(url)
}

export function marketplaceSlug(url: string): string {
  return url.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
}
