import asyncio
import json
import logging
from typing import Dict, Set
from fastapi import FastAPI, Request, Form, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaRelay

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("server")

app = FastAPI()
app.add_middleware(SessionMiddleware, secret_key="supersecret-key-change-this")

app.mount("/static", StaticFiles(directory="static"), name="static")

relay = MediaRelay()

channels: Dict[str, dict] = {}

VALID_USERNAME = "Admin"
VALID_PASSWORD = "churchaudio2025"


# --- AUTH & PAGES ---
@app.get("/")
async def get_client():
    with open("static/client.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

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
    return request.session.get("authenticated")

@app.get("/transmitter")
async def get_transmitter(request: Request):
    if not require_login(request):
        return RedirectResponse(url="/login")
    with open("static/transmitter.html", "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())

@app.get("/api/channels")
async def list_channels():
    return list(channels.keys())

async def broadcast_client_count(lang):
    if lang in channels:
        count = len(channels[lang]["listeners"])
        ws = channels[lang]["transmitter_ws"]
        try:
            await ws.send_text(json.dumps({
                "type": "client_count",
                "count": count
            }))
        except:
            pass

# --- TRANSMITTER WEBSOCKET ---
@app.websocket("/ws/transmitter")
async def transmitter_websocket(websocket: WebSocket):
    await websocket.accept()
    pc = None
    lang = None
    
    try:
        # 1. Wait for "config" message with language
        data = await websocket.receive_text()
        msg = json.loads(data)
        if msg.get("type") != "config":
            await websocket.close()
            return
            
        lang = msg["value"]
        
        if lang in channels:
            await websocket.send_text(json.dumps({"type": "error", "message": "Channel exists"}))
            await websocket.close()
            return

        pc = RTCPeerConnection()
        
        # 2. Setup Media Handling
        @pc.on("track")
        def on_track(track):
            if track.kind == "audio":
                logger.info(f"Channel created: {lang}")
                channels[lang] = {
                    "transmitter_pc": pc,
                    "transmitter_ws": websocket,
                    "track": track,
                    "listeners": set()
                }
                # Notify transmitter success
                asyncio.create_task(websocket.send_text(json.dumps({"type": "status", "message": "Transmitting"})))

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in ["failed", "closed"]:
                await websocket.close()

        # 3. Handle SDP Offer from Transmitter
        # We expect the next message to be the SDP offer
        data = await websocket.receive_text()
        offer_data = json.loads(data)
        
        offer = RTCSessionDescription(sdp=offer_data["sdp"], type=offer_data["type"])
        await pc.setRemoteDescription(offer)
        
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        
        # Send Answer back
        await websocket.send_text(json.dumps({
            "type": "answer",
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        }))

        # Keep connection open for stats updates
        while True:
            await websocket.receive_text() # Keep alive / ignore extra messages

    except WebSocketDisconnect:
        logger.info(f"Transmitter disconnected: {lang}")
    except Exception as e:
        logger.error(f"Transmitter Error: {e}")
    finally:
        # Cleanup
        if pc:
            await pc.close()
        if lang and lang in channels:
            # Close all listeners for this channel
            for listener_pc in channels[lang]["listeners"]:
                asyncio.create_task(listener_pc.close())
            del channels[lang]

# --- CLIENT WEBSOCKET ---
@app.websocket("/ws/client")
async def client_websocket(websocket: WebSocket):
    await websocket.accept()
    pc = None
    current_lang = None
    
    try:
        # 1. Wait for "join"
        data = await websocket.receive_text()
        msg = json.loads(data)
        if msg.get("type") != "join":
            return
            
        current_lang = msg["value"]
        
        if current_lang not in channels:
            await websocket.send_text(json.dumps({"type": "error", "message": "Channel not found"}))
            await websocket.close()
            return

        pc = RTCPeerConnection()
        
        # Add to listeners list
        channels[current_lang]["listeners"].add(pc)
        await broadcast_client_count(current_lang)

        # 2. Add Audio Track to PC
        source_track = channels[current_lang]["track"]
        pc.addTrack(relay.subscribe(source_track))

        # 3. Handle SDP Offer (Client sends offer)
        data = await websocket.receive_text()
        offer_data = json.loads(data)
        
        offer = RTCSessionDescription(sdp=offer_data["sdp"], type=offer_data["type"])
        await pc.setRemoteDescription(offer)
        
        answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        
        await websocket.send_text(json.dumps({
            "type": "answer",
            "sdp": pc.localDescription.sdp,
            "type": pc.localDescription.type
        }))

        # Wait for disconnect
        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        pass
    finally:
        if pc:
            await pc.close()
        if current_lang and current_lang in channels:
            if pc in channels[current_lang]["listeners"]:
                channels[current_lang]["listeners"].discard(pc)
                await broadcast_client_count(current_lang)

@app.on_event("shutdown")
async def on_shutdown():
    # Close all connections
    for lang, ch in channels.items():
        if ch["transmitter_pc"]:
            await ch["transmitter_pc"].close()
        for lpc in ch["listeners"]:
            await lpc.close()
    channels.clear()