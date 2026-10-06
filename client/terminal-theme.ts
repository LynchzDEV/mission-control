export const TERMINAL_THEMES = {
  light: { background: '#eaedf6', foreground: '#344155', cursor: '#8062bd', selectionBackground: '#b5a5d866' },
  dark: { background: '#23262e', foreground: '#e4e8f0', cursor: '#a58be2', selectionBackground: '#a58be255' },
}

export const TERMINAL_FONT = { fontFamily: 'Menlo, monospace', fontSize: 13 }

export const terminalTheme = (): (typeof TERMINAL_THEMES)['light'] => TERMINAL_THEMES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light']
