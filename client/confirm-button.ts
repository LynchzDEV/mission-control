export const DISARM_MS = 4000

export function confirmButton(button: HTMLButtonElement, confirmLabel: string, onConfirm: () => void): void {
  const idleLabel = button.getAttribute('aria-label') ?? ''
  let timer = 0
  const setArmed = (armed: boolean): void => {
    button.dataset.armed = String(armed)
    button.setAttribute('aria-label', armed ? `${confirmLabel}: click again to confirm` : idleLabel)
  }
  const disarm = (): void => {
    clearTimeout(timer)
    if (button.dataset.armed === 'true') setArmed(false)
  }
  button.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (button.dataset.armed === 'true') { disarm(); onConfirm(); return }
    setArmed(true)
    timer = window.setTimeout(disarm, DISARM_MS)
  })
  button.addEventListener('keydown', (event) => { if (event.key === 'Escape') disarm() })
  button.addEventListener('blur', disarm)
  button.parentElement?.addEventListener('mouseleave', disarm)
}
