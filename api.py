import os
import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from f1_data import (
    enable_cache, load_session, get_race_weekends,
    build_race_frames, get_circuit_rotation, get_track_map,
    get_cache_path, save_to_cache, load_from_cache,
)

app = FastAPI()
DT  = 1 / 25   # seconds per frame


# ── Race list ─────────────────────────────────────────────────────────────────

@app.get("/api/races/{year}")
def get_races(year: int):
    enable_cache()
    return get_race_weekends(year)


# ── Load session ──────────────────────────────────────────────────────────────
@app.get("/api/frames/{year}/{round}/{session_type}")
def get_frames(year: int, round: int, session_type: str):
    """Send all frames at once over HTTP — much faster than WebSocket streaming"""
    cache_path = get_cache_path(year, round, session_type)
    if not os.path.exists(cache_path):
        return {"error": "Session not loaded yet"}
    data = load_from_cache(cache_path)
    return {"frames": data["frames"]}

@app.get("/api/load/{year}/{round}/{session_type}")
def load_race(year: int, round: int, session_type: str):
    enable_cache()
    cache_path = get_cache_path(year, round, session_type)

    if os.path.exists(cache_path):
        print(f"Cache hit: {cache_path}")
        data = load_from_cache(cache_path)
    else:
        print("Cache miss — loading from FastF1...")
        session = load_session(year, round, session_type)
        data    = build_race_frames(session)

        data["circuit_rotation"] = get_circuit_rotation(session)
        data["track_map"]        = get_track_map(session)
        data["session_info"]     = {
            "event_name":   session.event.get("EventName", ""),
            "country":      session.event.get("Country", ""),
            "year":         year,
            "round":        round,
            "session_type": session_type,
            "total_laps":   data["total_laps"],
        }

        save_to_cache(cache_path, data)

    # Return metadata only — frames are streamed via WebSocket
    return {
        "status":           "ready",
        "total_frames":     len(data["frames"]),
        "total_laps":       data["total_laps"],
        "driver_colors":    {k: list(v) for k, v in data["driver_colors"].items()},
        "circuit_rotation": data.get("circuit_rotation", 0),
        "session_info":     data.get("session_info", {}),
        "track_statuses":   data.get("track_statuses", []),
        "track_map":        data.get("track_map", None),
    }


# ── WebSocket replay streamer ─────────────────────────────────────────────────

@app.websocket("/ws/replay/{year}/{round}/{session_type}")
async def replay_ws(websocket: WebSocket, year: int, round: int, session_type: str):
    await websocket.accept()
    print(f"WS connected: {year} R{round} {session_type}")

    cache_path = get_cache_path(year, round, session_type)
    if not os.path.exists(cache_path):
        await websocket.send_json({"error": "Session not loaded yet"})
        await websocket.close()
        return

    data   = load_from_cache(cache_path)
    frames = data["frames"]

    current = 0
    paused  = False
    speed   = 1.0

    try:
        while current < len(frames):
            # Check for control message from browser (non-blocking)
            try:
                msg = await asyncio.wait_for(websocket.receive_json(), timeout=0.001)
                action = msg.get("action")
                if   action == "pause":   paused = True
                elif action == "resume":  paused = False
                elif action == "speed":   speed  = float(msg.get("value", 1.0))
                elif action == "restart": current = 0; paused = False
                elif action == "seek":
                    pct     = float(msg.get("value", 0))
                    current = int(pct * len(frames))
            except asyncio.TimeoutError:
                pass

            if paused:
                await asyncio.sleep(0.05)
                continue

            await websocket.send_json(frames[current])
            current += 1
            await asyncio.sleep(DT / speed)

    except WebSocketDisconnect:
        print("Browser disconnected")


# ── Serve frontend ────────────────────────────────────────────────────────────

app.mount("/static", StaticFiles(directory="frontend"), name="static")

@app.get("/")
def root():
    return FileResponse("frontend/index.html")

@app.get("/replay")
def replay_page():
    return FileResponse("frontend/replay.html")
