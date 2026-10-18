from flask import Flask, render_template, request, Response
import os, html, hashlib, gzip as gz
from datetime import datetime

app = Flask(__name__)
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logs.txt')

APP_VERSION = 90

LOG_PAGES = {'/': True, '/settings': True, '/instruction': True, '/static/icons-preview.html': True, '/logs': True}


def device_from_ua(ua):
    ua = ua or ''
    u = ua.lower()
    if 'iphone' in u:
        dev = 'iPhone'
    elif 'ipad' in u:
        dev = 'iPad'
    elif 'android' in u:
        dev = 'Android'
    elif 'windows' in u:
        dev = 'Windows'
    elif 'macintosh' in u or 'mac os' in u:
        dev = 'Mac'
    elif 'linux' in u:
        dev = 'Linux'
    else:
        dev = '—'
    if 'safari' in u and 'crios' not in u and 'chrome' not in u and 'edg' not in u:
        br = 'Safari'
    elif 'edg' in u:
        br = 'Edge'
    elif 'crios' in u:
        br = 'Chrome (iOS)'
    elif 'chrome' in u:
        br = 'Chrome'
    elif 'firefox' in u:
        br = 'Firefox'
    else:
        br = '—'
    return dev, br


def write_log(line):
    try:
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


@app.before_request
def before_request():
    path = request.path
    if path in LOG_PAGES:
        try:
            now = datetime.now().strftime('%d.%m.%Y %H:%M:%S')
            dev, br = device_from_ua(request.headers.get('User-Agent', ''))
            ip = request.headers.get('X-Forwarded-For', '') or request.remote_addr or '?'
            ua = (request.headers.get('User-Agent') or '').replace(';', '').replace('|', '')
            write_log('%s | %s | %s | %s (%s) | UA=%s' % (now, ip.split(',')[0].strip(), path, dev, br, ua))
        except Exception:
            pass


@app.after_request
def after_request(response):
    path = request.path
    if path.startswith('/static/'):
        response.headers['Cache-Control'] = 'public, max-age=3600'
        response.headers.pop('Pragma', None)
        response.headers.pop('Expires', None)
        return response
    response.headers['Cache-Control'] = 'no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    ctype = response.mimetype or ''
    if ctype == 'text/html':
        response.headers['Accept-CH'] = 'Sec-CH-UA-Model'
    if ctype in ('text/html', 'text/css', 'application/javascript', 'application/json', 'text/plain'):
        response.headers['Vary'] = 'Accept-Encoding'
    body = response.get_data()
    if body and response.status_code == 200:
        etag = '"' + hashlib.md5(body).hexdigest() + '"'
        response.headers['ETag'] = etag
        if request.headers.get('If-None-Match') == etag:
            response.set_data(b'')
            response.status_code = 304
            response.headers['Content-Length'] = '0'
            return response
        if ctype in ('text/html', 'text/css', 'application/javascript', 'application/json', 'text/plain') \
                and len(body) > 1024 and 'gzip' in request.headers.get('Accept-Encoding', ''):
            response.set_data(gz.compress(body, 6, mtime=0))
            response.headers['Content-Encoding'] = 'gzip'
    return response


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/instruction')
def instruction():
    return render_template('instruction.html')


@app.route('/settings')
def settings():
    ua_model = (request.headers.get('Sec-CH-UA-Model', '') or '').strip()
    return render_template('settings.html', ua_model=ua_model)


@app.route('/api/version')
def api_version():
    return Response('{"build": %d}' % APP_VERSION, status=200, mimetype='application/json')


@app.route('/logs')
def logs():
    lines = []
    try:
        with open(LOG_FILE, 'r', encoding='utf-8') as f:
            lines = f.read().splitlines()
    except Exception:
        pass
    rows = ''
    for ln in reversed(lines):
        parts = ln.split(' | ')
        def g(i, d='—'):
            return html.escape(parts[i]) if i < len(parts) and parts[i].strip() else d
        rows += ('<tr><td class="t">%s</td><td class="ip">%s</td><td class="p">%s</td><td class="dv">%s</td>'
                 % (g(0), g(1), g(2), g(3)))
    total = len(lines)
    page = (
        '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Логи посещений</title>'
        '<style>body{margin:0;background:#000;color:#fff;font-family:-apple-system,"Segoe UI",sans-serif;padding:16px}'
        'h1{font-size:22px;font-weight:800;margin:4px 0 6px}p.cnt{color:#8e8e93;font-size:13px;margin:0 0 12px}'
        'table{width:100%;border-collapse:collapse;font-size:13px}td{padding:7px 6px;border-bottom:0.5px solid #2c2c2e;vertical-align:top}'
        'th{text-align:left;color:#8e8e93;font-size:11px;text-transform:uppercase;padding:6px;border-bottom:1px solid #3a3a3c}'
        'td.t{white-space:nowrap;color:#8e8e93}td.ip{white-space:nowrap}td.p{color:#0a84ff}td.dv{color:#ffd60a;font-size:12px}'
        'a{color:#0a84ff;text-decoration:none}'
        '</style></head><body><h1>Логи посещений</h1>'
        '<p class="cnt">Всего записей: __TOTAL__ · файл logs.txt · <a href="/logs">обновить</a></p>'
        '<table><tr><th>Время</th><th>IP</th><th>Страница</th><th>Устройство</th></tr>__ROWS__</table>'
        '</body></html>'
    ).replace('__TOTAL__', str(total)).replace('__ROWS__', rows)
    return Response(page, status=200, mimetype='text/html')


if __name__ == '__main__':
    print("Server running at http://127.0.0.1:5000 and http://0.0.0.0:80")
    from waitress import serve
    import threading

    def run_5000():
        try:
            serve(app, host='0.0.0.0', port=5000, threads=8)
        except Exception as e:
            print("Port 5000 error:", e)

    threading.Thread(target=run_5000, daemon=True).start()

    try:
        serve(app, host='0.0.0.0', port=80, threads=8)
    except Exception as e:
        print("Port 80 error:", e)