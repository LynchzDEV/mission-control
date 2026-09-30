export type AttachmentKind = 'image' | 'file'

export type AttachmentChip = { chip: HTMLElement; token: string; url: string | null; path: string; kind: AttachmentKind }

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export function attachmentKind(path: string, file: File | null): AttachmentKind {
  if (file !== null) return file.type.startsWith('image/') ? 'image' : 'file'
  const dot = path.lastIndexOf('.')
  const extension = dot > 0 ? path.slice(dot + 1).toLowerCase() : ''
  return IMAGE_EXTENSIONS.has(extension) ? 'image' : 'file'
}

export function formatSize(bytes: number): string {
  const kilobytes = bytes / 1024
  if (kilobytes < 10) return `${kilobytes.toFixed(1)} KB`
  if (kilobytes < 1024) return `${Math.round(kilobytes)} KB`
  return `${(kilobytes / 1024).toFixed(1)} MB`
}

const baseName = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

export function attachmentChip(path: string, file: File | null, quote: (path: string) => string): AttachmentChip {
  const chip = document.createElement('span')
  chip.className = 'attach-chip'
  const name = file?.name ?? baseName(path)
  let url: string | null = null
  if (file !== null && file.type.startsWith('image/')) {
    const thumb = document.createElement('img')
    thumb.className = 'attach-thumb'
    thumb.alt = ''
    url = URL.createObjectURL(file)
    thumb.src = url
    chip.append(thumb)
  } else {
    const icon = document.createElement('span')
    icon.className = 'attach-icon'
    icon.insertAdjacentHTML('afterbegin', '<svg><use href="#file-icon"/></svg>')
    chip.append(icon)
  }
  const nameLabel = document.createElement('span')
  nameLabel.className = 'attach-name'
  nameLabel.textContent = name
  chip.append(nameLabel)
  if (file !== null) {
    const size = document.createElement('span')
    size.className = 'attach-size'
    size.textContent = formatSize(file.size)
    chip.append(size)
  }
  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'attach-remove'
  remove.setAttribute('aria-label', `Remove ${name}`)
  remove.insertAdjacentHTML('afterbegin', '<svg><use href="#close-icon"/></svg>')
  chip.append(remove)
  return { chip, token: quote(path), url, path, kind: attachmentKind(path, file) }
}
