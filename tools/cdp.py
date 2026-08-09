import base64, hashlib, json, os, socket, struct, sys, urllib.request

def ws_connect(ws_url):
    # ws://host:port/path
    from urllib.parse import urlparse
    u = urlparse(ws_url)
    host, port = u.hostname, u.port
    s = socket.create_connection((host, port), timeout=60)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (f"GET {u.path} HTTP/1.1\r\nHost: {host}:{port}\r\n"
           "Upgrade: websocket\r\nConnection: Upgrade\r\n"
           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
    s.sendall(req.encode())
    resp = b""
    while b"\r\n\r\n" not in resp:
        resp += s.recv(4096)
    return s

def ws_send(s, payload):
    data = payload.encode()
    mask = os.urandom(4)
    n = len(data)
    header = b""
    if n < 126:
        header = bytes([0x81, 0x80 | n])
    elif n < 65536:
        header = bytes([0x81, 0x80 | 126]) + struct.pack(">H", n)
    else:
        header = bytes([0x81, 0x80 | 127]) + struct.pack(">Q", n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    s.sendall(header + mask + masked)

def ws_recv(s):
    h = s.recv(2)
    if not h: return None
    fin = h[0] & 0x80
    opcode = h[0] & 0x0f
    masked = h[1] & 0x80
    ln = h[1] & 0x7f
    if ln == 126:
        ln = struct.unpack(">H", s.recv(2))[0]
    elif ln == 127:
        ln = struct.unpack(">Q", s.recv(8))[0]
    mask = s.recv(4) if masked else b""
    data = b""
    while len(data) < ln:
        chunk = s.recv(ln - len(data))
        if not chunk: break
        data += chunk
    if masked:
        data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    if opcode == 1:
        return data.decode("utf-8", "replace")
    if opcode == 8:
        return None
    if opcode == 9:  # ping
        return None
    return data.decode("utf-8", "replace")

def eval_js(ws_url, expr):
    s = ws_connect(ws_url)
    payload = json.dumps({"id": 1, "method": "Runtime.evaluate",
                          "params": {"expression": expr, "returnByValue": True, "awaitPromise": True}})
    ws_send(s, payload)
    buf = ""
    while True:
        msg = ws_recv(s)
        if msg is None: break
        buf += msg
        try:
            obj = json.loads(buf)
        except Exception:
            continue
        if obj.get("id") == 1:
            s.close()
            return obj
        buf = ""

if __name__ == "__main__":
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
    expr = sys.argv[2] if len(sys.argv) > 2 else "document.body.innerText"
    sel = sys.argv[1]
    t = [t for t in targets if sel in t["url"]][0]
    res = eval_js(t["webSocketDebuggerUrl"], expr)
    print(json.dumps(res, ensure_ascii=False, indent=2)[:4000])
