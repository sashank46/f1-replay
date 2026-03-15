import os
import pickle
import numpy as np
import pandas as pd
import fastf1
import fastf1.plotting
from multiprocessing import Pool, cpu_count


# ── Cache setup ───────────────────────────────────────────────────────────────

def enable_cache():
    os.makedirs(".fastf1-cache", exist_ok=True)
    fastf1.Cache.enable_cache(".fastf1-cache")


# ── Constants ─────────────────────────────────────────────────────────────────

FPS = 25
DT  = 1 / FPS


# ── Session loading ───────────────────────────────────────────────────────────

def load_session(year, round_number, session_type="R"):
    session = fastf1.get_session(year, round_number, session_type)
    session.load(telemetry=True, weather=True)
    return session


def get_race_weekends(year):
    enable_cache()
    schedule = fastf1.get_event_schedule(year)
    weekends = []
    for _, event in schedule.iterrows():
        if event.is_testing():
            continue
        weekends.append({
            "round":   int(event["RoundNumber"]),
            "name":    event["EventName"],
            "country": event["Country"],
            "date":    str(event["EventDate"].date()),
            "format":  event["EventFormat"],
        })
    return weekends


# ── Driver colors ─────────────────────────────────────────────────────────────

def get_driver_colors(session):
    mapping = fastf1.plotting.get_driver_color_mapping(session)
    result  = {}
    for driver, hex_color in mapping.items():
        hex_color = hex_color.lstrip("#")
        rgb = tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))
        result[driver] = rgb
    return result


def get_circuit_rotation(session):
    return session.get_circuit_info().rotation


# ── Track map (real circuit outline from fastest lap) ─────────────────────────

def get_track_map(session):
    """
    Returns the real circuit X/Y coordinates from FastF1.
    Uses the fastest lap telemetry — this is the actual GPS track shape.
    """
    try:
        fastest = session.laps.pick_fastest()
        tel     = fastest.get_telemetry()
        return {
            "x": tel["X"].tolist(),
            "y": tel["Y"].tolist(),
        }
    except Exception as e:
        print(f"Track map error: {e}")
        return None


# ── Tyre helper ───────────────────────────────────────────────────────────────

TYRE_MAP = {"SOFT": 0, "MEDIUM": 1, "HARD": 2, "INTER": 3, "WET": 4}

def tyre_to_int(compound):
    if pd.isna(compound):
        return 0
    return TYRE_MAP.get(str(compound).upper(), 0)


# ── Single driver processing (runs in parallel) ───────────────────────────────

def _process_driver(args):
    driver_no, session, code = args
    print(f"  Processing {code}...")

    laps = session.laps.pick_drivers(driver_no)
    if laps.empty:
        return None

    t_all, x_all, y_all       = [], [], []
    dist_all, rd_all           = [], []
    lap_all, tyre_all, tl_all  = [], [], []
    spd_all, gear_all, drs_all = [], [], []
    total_dist = 0.0

    for _, lap in laps.iterlaps():
        tel = lap.get_telemetry()
        if tel.empty:
            continue

        t    = tel["SessionTime"].dt.total_seconds().to_numpy()
        x    = tel["X"].to_numpy()
        y    = tel["Y"].to_numpy()
        d    = tel["Distance"].to_numpy()
        rd   = tel["RelativeDistance"].to_numpy()
        spd  = tel["Speed"].to_numpy()
        gear = tel["nGear"].to_numpy()
        drs  = tel["DRS"].to_numpy()

        t_all.append(t)
        x_all.append(x)
        y_all.append(y)
        dist_all.append(total_dist + d)
        rd_all.append(rd)
        lap_all.append(np.full_like(t, lap.LapNumber))
        tyre_all.append(np.full_like(t, tyre_to_int(lap.Compound)))
        tl = lap.TyreLife if pd.notna(lap.TyreLife) else 0
        tl_all.append(np.full_like(t, tl))
        spd_all.append(spd)
        gear_all.append(gear)
        drs_all.append(drs)
        total_dist += d[-1] if len(d) else 0

    if not t_all:
        return None

    t    = np.concatenate(t_all)
    x    = np.concatenate(x_all)
    y    = np.concatenate(y_all)
    dist = np.concatenate(dist_all)
    rd   = np.concatenate(rd_all)
    lap  = np.concatenate(lap_all)
    tyre = np.concatenate(tyre_all)
    tl   = np.concatenate(tl_all)
    spd  = np.concatenate(spd_all)
    gear = np.concatenate(gear_all)
    drs  = np.concatenate(drs_all)

    order = np.argsort(t)
    return {
        "code": code,
        "t":    t[order],    "x":    x[order],
        "y":    y[order],    "dist": dist[order],
        "rd":   rd[order],   "lap":  lap[order],
        "tyre": tyre[order], "tl":   tl[order],
        "spd":  spd[order],  "gear": gear[order],
        "drs":  drs[order],
        "t_min":   t[order].min(),
        "t_max":   t[order].max(),
        "max_lap": laps.LapNumber.max(),
    }


# ── Build frames ──────────────────────────────────────────────────────────────

def build_race_frames(session):
    drivers      = session.drivers
    driver_codes = {n: session.get_driver(n)["Abbreviation"] for n in drivers}

    args    = [(n, session, driver_codes[n]) for n in drivers]
    n_cores = min(cpu_count(), len(drivers))

    print(f"Processing {len(drivers)} drivers on {n_cores} cores...")
    with Pool(processes=n_cores) as pool:
        results = pool.map(_process_driver, args)

    results = [r for r in results if r is not None]
    t_min   = min(r["t_min"] for r in results)
    t_max   = max(r["t_max"] for r in results)
    max_lap = max(r["max_lap"] for r in results)

    timeline = np.arange(t_min, t_max, DT)

    resampled = {}
    for r in results:
        code  = r["code"]
        t_rel = r["t"] - t_min
        order = np.argsort(t_rel)
        ts    = t_rel[order]
        tl    = timeline - t_min

        def rs(arr):
            return np.interp(tl, ts, arr[order])

        resampled[code] = {
            "x":    rs(r["x"]),    "y":    rs(r["y"]),
            "dist": rs(r["dist"]), "rd":   rs(r["rd"]),
            "lap":  rs(r["lap"]),  "tyre": rs(r["tyre"]),
            "tl":   rs(r["tl"]),   "spd":  rs(r["spd"]),
            "gear": rs(r["gear"]), "drs":  rs(r["drs"]),
        }

    # Track statuses (safety car, VSC etc.)
    track_statuses = []
    for status in session.track_status.to_dict("records"):
        t_sec = status["Time"].total_seconds() - t_min
        if track_statuses:
            track_statuses[-1]["end"] = t_sec
        track_statuses.append({
            "status": status["Status"],
            "start":  t_sec,
            "end":    None,
        })

    weather = _resample_weather(session, timeline, t_min)

    print("Building frames...")
    frames = []
    for i, t in enumerate(timeline - t_min):

        snapshot = []
        for code, d in resampled.items():
            snapshot.append({
                "code": code,
                "x":    float(d["x"][i]),
                "y":    float(d["y"][i]),
                "dist": float(d["dist"][i]),
                "lap":  int(round(d["lap"][i])),
                "rd":   float(d["rd"][i]),
                "tyre": int(round(d["tyre"][i])),
                "tl":   float(d["tl"][i]),
                "spd":  float(d["spd"][i]),
                "gear": int(d["gear"][i]),
                "drs":  int(d["drs"][i]),
            })

        snapshot.sort(key=lambda c: (c["lap"], c["dist"]), reverse=True)

        drivers_frame = {}
        for pos, car in enumerate(snapshot, start=1):
            drivers_frame[car["code"]] = {**car, "pos": pos}

        frame = {
            "t":       round(float(t), 3),
            "lap":     snapshot[0]["lap"] if snapshot else 0,
            "drivers": drivers_frame,
        }

        if weather:
            frame["weather"] = {
                "track_temp": _wval(weather["track_temp"], i),
                "air_temp":   _wval(weather["air_temp"],   i),
                "humidity":   _wval(weather["humidity"],   i),
                "wind_speed": _wval(weather["wind_speed"], i),
                "rain": "RAINING" if (_wval(weather["rainfall"], i) or 0) >= 0.5 else "DRY",
            }

        frames.append(frame)

    print(f"Done! {len(frames)} frames, {max_lap} laps")
    return {
        "frames":         frames,
        "track_statuses": track_statuses,
        "total_laps":     int(max_lap),
        "driver_colors":  get_driver_colors(session),
    }


# ── Weather ───────────────────────────────────────────────────────────────────

def _wval(arr, i):
    if arr is None:
        return None
    return round(float(arr[i]), 1)


def _resample_weather(session, timeline, t_min):
    df = getattr(session, "weather_data", None)
    if df is None or df.empty:
        return None
    try:
        wt    = df["Time"].dt.total_seconds().to_numpy() - t_min
        order = np.argsort(wt)
        wt    = wt[order]
        tl    = timeline - t_min

        def rs(col):
            if col not in df:
                return None
            return np.interp(tl, wt, df[col].to_numpy()[order])

        rain_raw = df["Rainfall"].to_numpy()[order] if "Rainfall" in df else None
        return {
            "track_temp": rs("TrackTemp"),
            "air_temp":   rs("AirTemp"),
            "humidity":   rs("Humidity"),
            "wind_speed": rs("WindSpeed"),
            "rainfall":   np.interp(tl, wt, rain_raw.astype(float)) if rain_raw is not None else None,
        }
    except Exception as e:
        print(f"Weather error: {e}")
        return None


# ── Cache helpers ─────────────────────────────────────────────────────────────

def get_cache_path(year, round_number, session_type):
    os.makedirs("cache", exist_ok=True)
    return f"cache/{year}_r{round_number}_{session_type}.pkl"


def save_to_cache(path, data):
    with open(path, "wb") as f:
        pickle.dump(data, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"Saved to cache: {path}")


def load_from_cache(path):
    with open(path, "rb") as f:
        return pickle.load(f)
