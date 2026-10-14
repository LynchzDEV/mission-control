// ponytail: legacy Mission Control markers in files written before Shikidan, drop once those files are regenerated
export function legacyNamed(text: string): string {
  return text.replaceAll('Shikidan', 'Mission Control').replaceAll('shikidan', 'mission-control')
}
