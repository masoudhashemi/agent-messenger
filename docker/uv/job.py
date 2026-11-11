import os
from pathlib import Path
import subprocess
import sys

UV = '/usr/local/bin/uv'
COMMON = ['--no-config', '--no-python-downloads', '--python', '/usr/local/bin/python', '--no-progress']
LOCAL = 'http://127.0.0.1:8123'
LOCK = Path('/workspace/uv.lock')

def rewrite(local):
    if not LOCK.exists():
        return
    if LOCK.is_symlink() or LOCK.stat().st_size > 8_000_000:
        raise ValueError('Invalid uv.lock')
    content = LOCK.read_text()
    replacements = [('https://pypi.org/simple', LOCAL + '/simple'), ('https://files.pythonhosted.org/', LOCAL + '/files/')]
    for public, gateway in replacements:
        content = content.replace(public, gateway) if local else content.replace(gateway, public)
    LOCK.write_text(content)

if __name__ == '__main__':
    action, *args = sys.argv[1:]
    if action == 'sync':
        try:
            rewrite(True)
            code = subprocess.call([UV, 'sync', *COMMON, '--no-sources', '--no-build', '--no-install-project', '--no-install-workspace', '--default-index', LOCAL + '/simple', '--link-mode', 'copy'])
        finally:
            rewrite(False)
        sys.exit(code)
    elif action == 'init':
        sys.exit(subprocess.call([UV, 'init', *COMMON, '--offline', '--bare', '--no-workspace', '--no-pin-python', '--vcs', 'none', '--name', 'agent-project']))
    elif action == 'venv':
        sys.exit(subprocess.call([UV, 'venv', *COMMON, '--offline', '/workspace/.venv']))
    elif action == 'run':
        if not Path('/workspace/.venv/bin/python').exists():
            sys.exit('Environment is missing. Use uv_venv or uv_sync first.')
        # --no-project avoids .env/config/metadata discovery and implicit sync.
        env = dict(os.environ, UV_PYTHON='/workspace/.venv/bin/python', VIRTUAL_ENV='/workspace/.venv', PATH='/workspace/.venv/bin:' + os.environ['PATH'])
        sys.exit(subprocess.call([UV, 'run', '--offline', '--no-project', '--no-config', '--no-python-downloads', '--', *args], env=env))
    else:
        sys.exit('Unknown uv action')
