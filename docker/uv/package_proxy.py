"""Read-only PyPI gateway. No CONNECT, arbitrary hosts, redirects, or uploads.
The job has network=none; it reaches this gateway only over a Unix socket.
"""
import http.client
import http.server
import ipaddress
import os
import re
import socket
import socketserver
import ssl
import threading
from urllib.parse import urlsplit

SOCKET = '/relay-proxy/packages.sock'
MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
used = 0
budget_lock = threading.Lock()

def upstream(path):
    if re.fullmatch(r'/simple/[a-z0-9][a-z0-9._-]*/?', path):
        return 'pypi.org', path.rstrip('/') + '/'
    if re.fullmatch(r'/files/packages/[a-zA-Z0-9_./+%~-]+', path) and '..' not in path and '%' not in path:
        return 'files.pythonhosted.org', path.removeprefix('/files')
    raise ValueError('Only PyPI package indexes and package files are available')

class PublicHTTPS(http.client.HTTPSConnection):
    def connect(self):
        addresses = socket.getaddrinfo(self.host, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
            raise ValueError('Non-public upstream address denied')
        last = None
        for family, kind, proto, _, address in addresses:
            raw = socket.socket(family, kind, proto)
            raw.settimeout(25)
            try:
                raw.connect(address)
                self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=self.host)
                return
            except OSError as error:
                last = error
                raw.close()
        raise last or OSError('Upstream unavailable')

class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, fmt, *args):
        pass
    def do_GET(self):
        global used
        try:
            host, path = upstream(self.path)
        except ValueError:
            self.send_error(403, 'Destination denied')
            return
        connection = PublicHTTPS(host, timeout=25)
        try:
            connection.request('GET', path, headers={'Accept': 'text/html', 'User-Agent': 'Relay-package-gateway/1'})
            response = connection.getresponse()
            if response.status != 200:
                self.send_error(response.status if response.status in (404, 410, 429) else 502, 'Package request failed')
                return
            raw_length = response.getheader('Content-Length')
            if raw_length is not None:
                size = int(raw_length)
                if size <= 0 or size > MAX_FILE:
                    self.send_error(413, 'Package response exceeds gateway limits')
                    return
                with budget_lock:
                    if used + size > MAX_TOTAL:
                        self.send_error(413, 'Install download budget exceeded')
                        return
                    used += size
            else:
                size = None
            if host == 'pypi.org' or size is None:
                body = response.read((size if size is not None else MAX_FILE) + 1)
                if not body or len(body) > (size if size is not None else MAX_FILE):
                    self.send_error(413, 'Package response exceeds gateway limits')
                    return
                if size is None:
                    with budget_lock:
                        if used + len(body) > MAX_TOTAL:
                            self.send_error(413, 'Install download budget exceeded')
                            return
                        used += len(body)
                if host == 'pypi.org':
                    # uv sees only local gateway URLs, including wheel metadata links.
                    body = body.replace(b'https://files.pythonhosted.org/', b'http://127.0.0.1:8123/files/')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8' if host == 'pypi.org' else 'application/octet-stream')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(200)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(size))
                self.end_headers()
                remaining = size
                while remaining:
                    data = response.read(min(65536, remaining))
                    if not data:
                        break
                    self.wfile.write(data)
                    remaining -= len(data)
        except (OSError, ValueError, http.client.HTTPException):
            self.close_connection = True
        finally:
            connection.close()

class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True
    request_queue_size = 32

if __name__ == '__main__':
    if os.path.exists(SOCKET):
        os.unlink(SOCKET)
    with Server(SOCKET, Handler) as server:
        os.chmod(SOCKET, 0o666)
        server.serve_forever()
