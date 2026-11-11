"""Expose the restricted Unix-socket gateway on loopback for uv only."""
import os
import select
import socket
import socketserver
import subprocess
import sys
import threading
import time

class Handler(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            upstream.connect('/relay-proxy/packages.sock')
            peers = [self.request, upstream]
            while True:
                ready, _, _ = select.select(peers, [], [], 30)
                if not ready:
                    return
                for peer in ready:
                    data = peer.recv(65536)
                    if not data:
                        return
                    (upstream if peer is self.request else self.request).sendall(data)
        except OSError:
            pass
        finally:
            upstream.close()

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

if __name__ == '__main__':
    for _ in range(100):
        if os.path.exists('/relay-proxy/packages.sock'):
            break
        time.sleep(.1)
    else:
        sys.exit('Package gateway did not start')
    with Server(('127.0.0.1', 8123), Handler) as server:
        threading.Thread(target=server.serve_forever, daemon=True).start()
        sys.exit(subprocess.call(sys.argv[1:]))
