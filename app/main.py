import asyncio
import json
import secrets
import time
from typing import Dict, Set, List

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

app = FastAPI(title="Web AirDrop (WebRTC + FastAPI)")

# CORS (adjust origins in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Room manager for signaling (in-memory)
class RoomManager:
    def __init__(self):
        self._rooms: Dict[str, Set[WebSocket]] = {}
        self._lock = asyncio.Lock()
        self._reserved_codes: Dict[str, float] = {}  # code -> expiry timestamp
        # Buffer signaling messages (JSON strings) when only one peer is in the room
        self._pending: Dict[str, List[str]] = {}

    async def reserve_code(self, ttl_seconds: int = 120) -> str:
        # Reserve a 6-digit numeric code
        async with self._lock:
            self._cleanup_reservations()
            for _ in range(10):
                code = f"{secrets.randbelow(1_000_000):06d}"
                if code not in self._rooms and code not in self._reserved_codes:
                    self._reserved_codes[code] = time.time() + ttl_seconds
                    return code
            code = f"{secrets.randbelow(1_000_000):06d}"
            self._reserved_codes[code] = time.time() + ttl_seconds
            return code

    def _cleanup_reservations(self):
        now = time.time()
        expired = [c for c, exp in self._reserved_codes.items() if exp < now]
        for c in expired:
            self._reserved_codes.pop(c, None)

    async def connect(self, code: str, websocket: WebSocket) -> List[str]:
        """Add a websocket to the room and return any pending messages to be
        flushed to this websocket (typically messages sent by the first peer
        before the second joined)."""
        async with self._lock:
            conns = self._rooms.get(code)
            if conns is None:
                conns = set()
                self._rooms[code] = conns
            # max 2 peers per room for this MVP
            if len(conns) >= 2:
                raise HTTPException(status_code=409, detail="Room already has 2 participants.")
            conns.add(websocket)
            # Remove reservation since it's now in use
            self._reserved_codes.pop(code, None)

            pending_to_flush: List[str] = []
            # If this connection makes two peers present, flush any pending signaling to the newcomer
            if len(conns) == 2:
                pending_to_flush = self._pending.pop(code, [])
            return pending_to_flush

    async def disconnect(self, code: str, websocket: WebSocket):
        async with self._lock:
            conns = self._rooms.get(code)
            if conns and websocket in conns:
                conns.remove(websocket)
                if not conns:
                    # No one left — clean up room and any pending
                    self._rooms.pop(code, None)
                    self._pending.pop(code, None)

    async def broadcast_to_room(self, code: str, message: dict, sender: WebSocket):
        """Broadcast message to other peers. If there is no recipient yet and the
        message is signaling (sdp/ice), buffer it to replay when a second peer joins."""
        data = json.dumps(message)
        recipients: Set[WebSocket] = set()
        should_buffer = False

        async with self._lock:
            conns = self._rooms.get(code, set())
            recipients = {ws for ws in conns if ws is not sender}

            if not recipients:
                # Only buffer signaling messages; ignore others like peer-joined
                mtype = message.get("type")
                if mtype in {"sdp", "ice"}:
                    self._pending.setdefault(code, []).append(data)
                    # Avoid unbounded growth; keep only the last N (e.g., 200)
                    if len(self._pending[code]) > 200:
                        self._pending[code] = self._pending[code][-200:]
                # Nothing to send right now
                return

        # Send outside the lock
        for ws in recipients:
            try:
                await ws.send_text(data)
            except RuntimeError:
                pass

room_manager = RoomManager()

@app.get("/api/new-code")
async def new_code():
    code = await room_manager.reserve_code()
    return {"code": code}

@app.websocket("/ws/{code}")
async def websocket_endpoint(websocket: WebSocket, code: str):
    await websocket.accept()
    try:
        pending = await room_manager.connect(code, websocket)
    except HTTPException:
        await websocket.close(code=4400)
        return

    # If there were buffered signaling messages (e.g., sender offered before receiver joined),
    # replay them to this new peer right away.
    for payload in pending:
        try:
            await websocket.send_text(payload)
        except RuntimeError:
            pass

    # Notify others a peer joined (not buffered)
    await room_manager.broadcast_to_room(code, {"type": "peer-joined"}, sender=websocket)

    try:
        while True:
            msg = await websocket.receive_text()
            try:
                payload = json.loads(msg)
            except json.JSONDecodeError:
                continue
            await room_manager.broadcast_to_room(code, payload, sender=websocket)
    except WebSocketDisconnect:
        pass
    finally:
        await room_manager.disconnect(code, websocket)
        await room_manager.broadcast_to_room(code, {"type": "peer-disconnected"}, sender=websocket)

# Serve static frontend
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root_index():
    return FileResponse("static/index.html")