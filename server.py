from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, Form
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
import asyncio
import json

app = FastAPI()
app.add_middleware(SessionMiddleware, secret_key="supersecret-key-change-this")  # change key

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Global state
channels = {}  # lang -> {"transmitter": ws, "clients": set(ws), "init": Optional[bytes]}
VALID_USERNAME = "admin"
VALID_PASSWORD = "churchaudio2025"  # change this to something unique

@app.get("/")
async def get_client():
    with open("static/client.html", "r", encoding="utf-8") as f:
        content = f.read()
    return HTMLResponse(content)

@app.get("/login")
async def login_page(request: Request):
    with open("static/login.html", "r", encoding="utf-8") as f:
        request.session.clear()
        return HTMLResponse(f.read())

@app.post("/login")
async def login(request: Request, username: str = Form(...), password: str = Form(...)):
    if username == VALID_USERNAME and password == VALID_PASSWORD:
        request.session["authenticated"] = True
        return RedirectResponse(url="/transmitter", status_code=302)
    return HTMLResponse("<h3>Invalid credentials. <a href='/login'>Try again</a></h3>", status_code=401)

def require_login(request: Request):
    if not request.session.get("authenticated"):
        return False
    return True

@app.get("/test")
async def test():
    return {"status": "ok", "channels": list(channels.keys())}

@app.get("/transmitter")
async def get_transmitter(request: Request):
    if not require_login(request):
        return RedirectResponse(url="/login")
    with open("static/transmitter.html", "r", encoding="utf-8") as f:
        content = f.read()
    return HTMLResponse(content)

@app.websocket("/ws/transmitter")
async def transmitter_websocket(websocket: WebSocket):
    await websocket.accept()
    websocket.max_size = None
    lang = None
    try:
        data = await websocket.receive_text()
        lang = data.strip()
        if lang in channels:
            await websocket.send_text("Channel already exists")
            await websocket.close()
            return
        channels[lang] = {"transmitter": websocket, "clients": set(), "init": None}

        await websocket.send_text("Channel created")

        async def send_client_count():
            while True:
                if lang not in channels:
                    break
                client_count = len(channels[lang]["clients"])
                try:
                    await websocket.send_text(json.dumps({
                        "type": "client_count",
                        "count": client_count
                    }))
                except:
                    break
                await asyncio.sleep(2)

        asyncio.create_task(send_client_count())

        def _has_webm_tracks(buf: bytes) -> bool:
            # WebM 'Tracks' element ID is 0x1654AE6B. Look for that byte sequence.
            try:
                return b"\x16\x54\xAE\x6B" in buf
            except Exception:
                return False

        async def _finalize_init_after_delay(lang_key, max_delay=0.7, poll_interval=0.05):
            # Collect initial chunks and finalize when we detect the WebM Tracks element
            # or when max_delay is reached. Polls the init_buffer periodically.
            waited = 0.0
            while waited < max_delay:
                await asyncio.sleep(poll_interval)
                waited += poll_interval
                ch = channels.get(lang_key)
                if not ch:
                    return
                buf = ch.get("init_buffer")
                if buf and _has_webm_tracks(buf):
                    # Found Tracks element — finalize init
                    ch.pop("init_buffer", None)
                    ch["init"] = buf
                    return
            # Timeout reached — finalize whatever we have
            ch = channels.get(lang_key)
            if not ch:
                return
            buf = ch.pop("init_buffer", None)
            if buf:
                ch["init"] = buf

        while True:
            data = await websocket.receive_bytes()
            # Collect an initial buffer over a short window to form a more complete init segment
            if channels.get(lang) and channels[lang].get("init") is None:
                # append to init_buffer
                buf = channels[lang].get("init_buffer")
                if buf is None:
                    channels[lang]["init_buffer"] = data
                    # schedule finalization after a short delay
                    asyncio.create_task(_finalize_init_after_delay(lang, 0.3))
                else:
                    channels[lang]["init_buffer"] = buf + data
            clients = channels[lang]["clients"]
            for client in list(clients):
                try:
                    await client.send_bytes(data)
                except:
                    clients.remove(client)
    except WebSocketDisconnect:
        pass
    finally:
        if lang and lang in channels:
            del channels[lang]

@app.websocket("/ws/client")
async def client_websocket(websocket: WebSocket):
    await websocket.accept()
    websocket.max_size = None
    current_lang = None
    try:
        while True:
            data = await websocket.receive_text()
            if data == "list_channels":
                await websocket.send_text(json.dumps(list(channels.keys())))
            elif data.startswith("join "):
                lang = data[5:].strip()
                if lang in channels:
                    if current_lang:
                        channels[current_lang]["clients"].discard(websocket)
                    channels[lang]["clients"].add(websocket)
                    current_lang = lang
                    init_seg = channels[lang].get("init")
                    if init_seg:
                        await websocket.send_bytes(init_seg)
                    await websocket.send_text("Joined")
                else:
                    await websocket.send_text("Channel not found")
            elif data == "leave":
                if current_lang:
                    channels[current_lang]["clients"].discard(websocket)
                    current_lang = None
                    await websocket.send_text("Left")
    except WebSocketDisconnect:
        pass
    finally:
        if current_lang:
            channels[current_lang]["clients"].discard(websocket)
