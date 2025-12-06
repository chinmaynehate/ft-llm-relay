import os
import time
import json
import asyncio
from typing import Dict, List, Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

app = FastAPI(title="FT LLM Relay", version="0.1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")


class Client:
    def __init__(self, websocket: WebSocket, client_id: str, role: str, room: str):
        self.ws = websocket
        self.id = client_id
        self.role = role
        self.room = room
        self.connected_at = time.time()

    def as_dict(self):
        return {
            "id": self.id,
            "role": self.role,
            "room": self.room,
            "connected_at": self.connected_at,
        }


class Room:
    def __init__(self, name: str):
        self.name = name
        self.clients: Dict[str, Client] = {}

    def role_map(self) -> Dict[str, List[str]]:
        m: Dict[str, List[str]] = {}
        for cid, c in self.clients.items():
            m.setdefault(c.role, []).append(cid)
        return m

    def as_dict(self):
        rm = self.role_map()
        return {
            "room": self.name,
            "counts": {r: len(v) for r, v in rm.items()},
            "total": len(self.clients),
        }


class Hub:
    def __init__(self):
        self.rooms: Dict[str, Room] = {}
        self.lock = asyncio.Lock()

    def _room(self, name: str) -> Room:
        if name not in self.rooms:
            self.rooms[name] = Room(name)
        return self.rooms[name]

    async def connect(self, ws: WebSocket, client_id: str, role: str, room: str) -> Client:
        await ws.accept()
        async with self.lock:
            r = self._room(room)
            c = Client(ws, client_id, role, room)
            r.clients[client_id] = c
            return c

    async def disconnect(self, client: Client):
        async with self.lock:
            r = self.rooms.get(client.room)
            if r and client.id in r.clients:
                del r.clients[client.id]
            if r and not r.clients:
                del self.rooms[client.room]

    async def broadcast_room(self, room: str, message: dict, exclude: Optional[str] = None):
        r = self.rooms.get(room)
        if not r:
            return
        txt = json.dumps(message)
        for cid, c in list(r.clients.items()):
            if exclude and cid == exclude:
                continue
            try:
                await c.ws.send_text(txt)
            except Exception:
                pass

    async def send_to_role(self, room: str, role: str, message: dict, exclude: Optional[str] = None):
        r = self.rooms.get(room)
        if not r:
            return
        txt = json.dumps(message)
        for cid, c in list(r.clients.items()):
            if c.role == role and (not exclude or cid != exclude):
                try:
                    await c.ws.send_text(txt)
                except Exception:
                    pass

    def list_rooms(self) -> List[dict]:
        return [r.as_dict() for r in self.rooms.values()]

    def list_clients(self, room: Optional[str] = None) -> List[dict]:
        out: List[dict] = []
        if room:
            r = self.rooms.get(room)
            if r:
                out = [c.as_dict() for c in r.clients.values()]
        else:
            for r in self.rooms.values():
                out += [c.as_dict() for c in r.clients.values()]
        return out


hub = Hub()


def now_ms() -> int:
    return int(time.time() * 1000)


def norm_room(room: Optional[str]) -> str:
    r = (room or "").strip()
    return r if r else "ft-llm"


def norm_role(role: Optional[str]) -> str:
    r = (role or "").strip().lower()
    return r if r in ("hpc", "ui") else "hpc"


@app.get("/health")
async def health():
    return {"ok": True, "ts": now_ms()}


@app.get("/")
async def index():
    html = Path("app/templates/index.html").read_text(encoding="utf-8")
    return HTMLResponse(html)


@app.get("/rooms")
async def rooms():
    return hub.list_rooms()


@app.get("/clients")
async def clients(room: Optional[str] = None):
    return {"clients": hub.list_clients(room)}


@app.websocket("/ws/{room}/{client_id}")
async def ws_room(websocket: WebSocket, room: str, client_id: str):
    role = norm_role(websocket.query_params.get("role"))
    room = norm_room(room)
    client = await hub.connect(websocket, client_id, role, room)

    join_msg = {
        "type": "status",
        "status": "connected",
        "room": room,
        "client_id": client_id,
        "role": role,
        "server_ts": now_ms(),
    }
    await hub.broadcast_room(room, join_msg, exclude=client_id)

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except Exception:
                continue

            mtype = data.get("type")
            data["server_ts"] = now_ms()
            data.setdefault("room", room)
            data.setdefault("from", client_id)
            data.setdefault("role", role)

            # Routing rules
            if mtype in ("gpu_status", "token_update", "event", "metrics", "recovery_event"):
                # HPC -> UI
                await hub.send_to_role(room, "ui", data, exclude=client_id)
            elif mtype in ("kill_gpu", "submit_prompt", "cancel_request"):
                # UI -> HPC
                await hub.send_to_role(room, "hpc", data, exclude=client_id)
            else:
                # fallback: broadcast
                await hub.broadcast_room(room, data, exclude=client_id)

    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(client)
        leave_msg = {
            "type": "status",
            "status": "disconnected",
            "room": room,
            "client_id": client_id,
            "role": role,
            "server_ts": now_ms(),
        }
        await hub.broadcast_room(room, leave_msg, exclude=client_id)


@app.websocket("/ws/{client_id}")
async def ws_default(websocket: WebSocket, client_id: str):
    await ws_room(websocket, "ft-llm", client_id)
