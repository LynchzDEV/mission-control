import gen_sidebar as sb

VARIANTS = [
    ('a', 'A · floating raised panel'),
    ('b', 'B · raised controls, raised selected row'),
    ('c', 'C · sunken list well, raised controls'),
]
TOGGLE_JS = "<script>document.addEventListener('click',e=>{const b=e.target.closest('[title=\"Hide sidebar\"],[title=\"Show sidebar\"]');if(b)document.querySelector('.sb-shell').classList.toggle('collapsed')})</script>"

open_page = sb.variant_a()
mini_page = sb.variant_c()
mini_aside = mini_page[mini_page.index('<aside class="sb mini">'):mini_page.index('</aside>', mini_page.index('<aside class="sb mini">')) + 8]
mini_aside = mini_aside.replace('<a class="sb-mini" title="Fix chat scroll + markdown">', '<a class="sb-mini sel" title="Fix chat scroll + markdown">')

foot_start = open_page.index('<p class="mock-foot">')
foot_end = open_page.index('</p>', foot_start) + 4
for key, title in VARIANTS:
    html = open_page[:foot_start] + f'<p class="mock-foot">{title} — click the sidebar button to collapse / expand</p>' + open_page[foot_end:]
    html = html.replace('<title>Sidebar — A</title>', f'<title>Sidebar neu — {key.upper()}</title>')
    html = html.replace('href="sidebar-mock.css">', 'href="sidebar-mock.css"><link rel="stylesheet" href="sidebar-neu.css">')
    html = html.replace('<body>', f'<body class="neu-{key}">')
    html = html.replace('<main class="canvas">', mini_aside + '<main class="canvas">', 1)
    html = html.replace('<script src="frame.js"></script>', '<script src="frame.js"></script>' + TOGGLE_JS)
    open(f'sidebar-neu-{key}.html', 'w').write(html)
