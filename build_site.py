# -*- coding: utf-8 -*-
"""Собирает статический сайт в site/ для GitHub Pages (без сервера)."""
import os, re, shutil

ROOT = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.join(ROOT, 'site')


def relink(text):
    # /static/... -> static/... (относительные пути, Pages живёт под /fake-settings/)
    text = re.sub(r'([\'"(=])/(static/)', r'\1\2', text)
    text = text.replace('href="/settings"', 'href="settings.html"')
    text = text.replace('href="/instruction"', 'href="instruction.html"')
    text = text.replace('href="/"', 'href="index.html"')
    text = text.replace("location.replace('/settings')", "location.replace('settings.html')")
    return text


def build():
    if os.path.isdir(SITE):
        shutil.rmtree(SITE)
    os.makedirs(SITE)
    shutil.copytree(os.path.join(ROOT, 'static'), os.path.join(SITE, 'static'))

    # index.html — меню выбора проекта
    with open(os.path.join(ROOT, 'templates', 'index.html'), encoding='utf-8') as f:
        idx = relink(f.read())
    with open(os.path.join(SITE, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(idx)

    # instruction.html
    with open(os.path.join(ROOT, 'templates', 'instruction.html'), encoding='utf-8') as f:
        ins = relink(f.read())
    with open(os.path.join(SITE, 'instruction.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(ins)

    # settings.html — без Jinja и без автобновления версии с сервера
    with open(os.path.join(ROOT, 'templates', 'settings.html'), encoding='utf-8') as f:
        st = f.read()
    st = st.replace('var UA_MODEL = {{ ua_model|tojson }};', 'var UA_MODEL = null;')
    st = st.replace('setInterval(check, 2000);',
                    'if (!/\\.github\\.io$/.test(location.hostname)) setInterval(check, 2000);')
    st = relink(st)
    with open(os.path.join(SITE, 'settings.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(st)

    # manifest.json — пути разрешаются относительно static/manifest.json
    manifest = {
        'name': 'Fake Settings',
        'short_name': 'Fake Settings',
        'start_url': '../settings.html',
        'scope': '../',
        'display': 'standalone',
        'orientation': 'portrait',
        'background_color': '#0e1116',
        'theme_color': '#0e1116',
        'icons': [
            {'src': 'icon-180.png', 'sizes': '180x180', 'type': 'image/png', 'purpose': 'any'},
            {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'any'},
        ],
    }
    import json
    with open(os.path.join(SITE, 'static', 'manifest.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    with open(os.path.join(SITE, '.nojekyll'), 'w') as f:
        f.write('')
    print('site/ собран:', sum(len(files) for _, _, files in os.walk(SITE)), 'файлов')


if __name__ == '__main__':
    build()
