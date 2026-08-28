export interface WidgetProps {
  label: string
  target: HTMLElement
}

export async function mountWidget(props: WidgetProps): Promise<void> {
  const el = document.createElement('div')
  el.textContent = props.label
  props.target.appendChild(el)
  await Promise.resolve()
}
