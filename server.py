import asyncio
import json
import logging
from typing import Dict, Set, Tuple
from fastapi import FastAPI, Request, Form, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse # Added JSONResponse
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
        # Return JSON success signal instead of forced redirect
        return JSONResponse({"success": True, "redirect": "/transmitter"})
    
    # Return JSON error signal
    return JSONResponse(
        {"success": False, "message": "Incorrect Username or Password"}, 
        status_code=401
    )

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
        data = await websocket.receive_text()
        msg = json.loads(data)
        if msg.get("type") != "config":
            await websocket.close()
            return
            
        lang = msg["value"]
        
        if lang in channels:
            # Send error as JSON message, not alert
            await websocket.send_text(json.dumps({"type": "error", "message": f"Channel '{lang}' is busy."}))
            await websocket.close()
            return

        pc = RTCPeerConnection()
        
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
                asyncio.create_task(websocket.send_text(json.dumps({"type": "status", "message": "Transmitting"})))

        @pc.on("connectionstatechange")
        async def on_connectionstatechange():
            if pc.connectionState in ["failed", "closed"]:
                await websocket.close()

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

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        logger.info(f"Transmitter disconnected: {lang}")
    except Exception as e:
        logger.error(f"Transmitter Error: {e}")
    finally:
        if pc:
            await pc.close()
        
        if lang and lang in channels:
            listeners = channels[lang]["listeners"]
            for l_pc, l_ws in listeners:
                try:
                    await l_ws.send_text(json.dumps({
                        "type": "channel_closed", 
                        "message": "Broadcast ended by host"
                    }))
                except:
                    pass
                asyncio.create_task(l_pc.close())
            
            del channels[lang]

# --- CLIENT WEBSOCKET ---
@app.websocket("/ws/client")
async def client_websocket(websocket: WebSocket):
    await websocket.accept()
    pc = None
    current_lang = None
    
    try:
        data = await websocket.receive_text()
        msg = json.loads(data)
        if msg.get("type") != "join":
            return
            
        current_lang = msg["value"]
        
        if current_lang not in channels:
            await websocket.send_text(json.dumps({"type": "error", "message": "Channel unavailable"}))
            await websocket.close()
            return

        pc = RTCPeerConnection()
        
        channels[current_lang]["listeners"].add((pc, websocket))
        await broadcast_client_count(current_lang)

        source_track = channels[current_lang]["track"]
        pc.addTrack(relay.subscribe(source_track))

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

        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        pass
    finally:
        if pc:
            await pc.close()
        if current_lang and current_lang in channels:
            channels[current_lang]["listeners"].discard((pc, websocket))
            await broadcast_client_count(current_lang)