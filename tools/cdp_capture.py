#!/usr/bin/env python3
import base64, json, socket, struct, sys, urllib.request

port = int(sys.argv[1]) if len(sys.argv) > 1 else 9333
selector = sys.argv[2] if len(sys.argv) > 2 else 'index.html'
out = sys.argv[3] if len(sys.argv) > 3 else 'screenshots/deepcool-linux-port.png'

def recv_exact(sock, n):
    data = b''
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise EOFError('websocket closed')
        data += chunk
    return data

def connect(ws_url):
    rest = ws_url.removeprefix('ws://')
    hostport, path = rest.split('/', 1)
    host, port_s = hostport.rsplit(':', 1)
    sock = socket.create_connection((host, int(port_s)))
    import os
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f'GET /{path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n')
    sock.sendall(req.encode())
    header = b''
    while b'\r\n\r\n' not in header:
        header += sock.recv(4096)
    if b' 101 ' not in header.split(b'\r\n', 1)[0]:
        raise RuntimeError(header.decode(errors='replace'))
    return sock

def send_text(sock, text):
    payload = text.encode()
    first = 0x81
    mask = b'\x12\x34\x56\x78'
    n = len(payload)
    if n < 126:
        head = bytes([first, 0x80 | n])
    elif n < 65536:
        head = bytes([first, 0x80 | 126]) + struct.pack('>H', n)
    else:
        head = bytes([first, 0x80 | 127]) + struct.pack('>Q', n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    sock.sendall(head + mask + masked)

def recv_text(sock):
    first, second = recv_exact(sock, 2)
    opcode = first & 0x0f
    n = second & 0x7f
    if n == 126:
        n = struct.unpack('>H', recv_exact(sock, 2))[0]
    elif n == 127:
        n = struct.unpack('>Q', recv_exact(sock, 8))[0]
    mask = recv_exact(sock, 4) if second & 0x80 else None
    payload = recv_exact(sock, n)
    if mask:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    if opcode == 8:
        raise EOFError('closed')
    return payload.decode(errors='replace')

targets = json.load(urllib.request.urlopen(f'http://127.0.0.1:{port}/json'))
target = next(t for t in targets if selector in t['url'])
sock = connect(target['webSocketDebuggerUrl'])
send_text(sock, json.dumps({'id': 1, 'method': 'Page.captureScreenshot', 'params': {'format': 'png', 'fromSurface': True, 'captureBeyondViewport': False}}))
while True:
    msg = json.loads(recv_text(sock))
    if msg.get('id') == 1:
        if 'error' in msg:
            raise RuntimeError(msg['error'])
        data = base64.b64decode(msg['result']['data'])
        with open(out, 'wb') as f:
            f.write(data)
        print(out, len(data))
        break
