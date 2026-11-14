"""Sun and Earth positions seen from the Moon, from JPL Horizons.

    python -I pipeline/ephemeris.py [--start 2000] [--end 2050] [--validate]

The Horizons API sends no CORS headers, so the browser cannot query it live. Instead the
pipeline fetches the states once and ships them as small static files. The viewer
Hermite-interpolates them for any date/time in range.

Output: web/public/ephem/{year}.bin (little-endian)
    0   char[4]  "MEPH"
    4   u32      version (1)
    8   f64      JD (TDB) of the first sample
    16  f64      step (days)
    24  u32      sample count n
    28  u32      body count (2: Sun, Earth)
    32  f32[n][2][6]  x, y, z (km), vx, vy, vz (km/s)

Frame: ICRF (J2000 equatorial), origin at the Moon's centre (500@301). States are
light-time corrected (VEC_CORR='LT'), i.e. where the bodies are seen from the Moon.

--validate compares the Moon orientation model used by the viewer (time-dependent IAU
WGCCRE 2015 series, mirrored in web/src/orientation.ts) against Horizons' own sub-solar
and sub-Earth points on the Moon, and prints the angular errors.
"""
from __future__ import annotations

import argparse
import json
import struct
import time
from pathlib import Path

import numpy as np
import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "public" / "ephem"
API = "https://ssd.jpl.nasa.gov/api/horizons.api"
UA = {"User-Agent": "moon-lod-pipeline/1.0 (python-requests)"}
STEP_H = 6
BODIES = [("10", "Sun"), ("399", "Earth")]


def horizons(params: dict) -> str:
    q = {"format": "json", "OBJ_DATA": "'NO'", "CSV_FORMAT": "'YES'"}
    q.update({k: f"'{v}'" for k, v in params.items()})
    for attempt in range(6):
        try:
            r = requests.get(API, params=q, timeout=120, headers=UA)
            r.raise_for_status()
            res = r.json()
            if "result" not in res:
                raise RuntimeError(res)
            return res["result"]
        except Exception as e:  # noqa: BLE001
            if attempt == 5:
                raise
            print(f"   retry ({e})")
            time.sleep(5 * (attempt + 1))
    raise AssertionError


def table(text: str) -> list[list[str]]:
    a, b = text.index("$$SOE"), text.index("$$EOE")
    rows = []
    for line in text[a + 5:b].strip().splitlines():
        rows.append([c.strip() for c in line.split(",")])
    return rows


def fetch_vectors(body: str, start: str, stop: str) -> np.ndarray:
    t = horizons({
        "COMMAND": body, "CENTER": "500@301", "EPHEM_TYPE": "VECTORS",
        "START_TIME": start, "STOP_TIME": stop, "STEP_SIZE": f"{STEP_H} h",
        "REF_PLANE": "FRAME", "REF_SYSTEM": "ICRF", "VEC_TABLE": "2", "VEC_CORR": "LT",
        "OUT_UNITS": "KM-S", "VEC_LABELS": "NO",
    })
    rows = table(t)
    return np.array([[float(r[0])] + [float(v) for v in r[2:8]] for r in rows])


def cmd_fetch(start_year: int, end_year: int) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    total = 0
    for y in range(start_year, end_year + 1):
        path = OUT / f"{y}.bin"
        if path.exists():
            total += path.stat().st_size
            continue
        data = [fetch_vectors(b, f"{y}-01-01", f"{y + 1}-01-01") for b, _ in BODIES]
        n = len(data[0])
        assert all(len(d) == n for d in data)
        jd = data[0][:, 0]
        step = float(np.median(np.diff(jd)))
        arr = np.stack([d[:, 1:7] for d in data], axis=1).astype("<f4")  # n, 2, 6
        blob = struct.pack("<4sIddII", b"MEPH", 1, float(jd[0]), step, n, len(BODIES)) + arr.tobytes()
        path.write_bytes(blob)
        total += len(blob)
        print(f"ephemeris {y}: {n} samples, {len(blob) / 1024:.0f} KB", flush=True)
        time.sleep(0.5)  # be polite to the API
    (OUT / "index.json").write_text(json.dumps({
        "start": start_year, "end": end_year, "stepHours": STEP_H,
        "bodies": [b[1] for b in BODIES], "frame": "ICRF, Moon-centred, light-time corrected",
        "source": "JPL Horizons API (https://ssd.jpl.nasa.gov/api/horizons.api)",
    }, indent=1))
    print(f"ephemeris total {total / 1e6:.2f} MB in {OUT}")


# ------------------------------------------------------------------ orientation
def iau_moon(jd_tdb: float) -> np.ndarray:
    """IAU WGCCRE 2015 (Archinal et al. 2018) Moon orientation: body -> ICRF matrix."""
    d = jd_tdb - 2451545.0
    T = d / 36525.0
    E = np.radians([
        125.045 - 0.0529921 * d, 250.089 - 0.1059842 * d, 260.008 + 13.0120009 * d,
        176.625 + 13.3407154 * d, 357.529 + 0.9856003 * d, 311.589 + 26.4057084 * d,
        134.963 + 13.0649930 * d, 276.617 + 0.3287146 * d, 34.226 + 1.7484877 * d,
        15.134 - 0.1589763 * d, 119.743 + 0.0036096 * d, 239.961 + 0.1643573 * d,
        25.053 + 12.9590088 * d,
    ])
    s, c = np.sin(E), np.cos(E)
    a0 = (269.9949 + 0.0031 * T - 3.8787 * s[0] - 0.1204 * s[1] + 0.0700 * s[2] - 0.0172 * s[3]
          + 0.0072 * s[5] - 0.0052 * s[9] + 0.0043 * s[12])
    d0 = (66.5392 + 0.0130 * T + 1.5419 * c[0] + 0.0239 * c[1] - 0.0278 * c[2] + 0.0068 * c[3]
          - 0.0029 * c[5] + 0.0009 * c[6] + 0.0008 * c[9] - 0.0009 * c[12])
    W = (38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * s[0] + 0.1208 * s[1] - 0.0642 * s[2]
         + 0.0158 * s[3] + 0.0252 * s[4] - 0.0066 * s[5] - 0.0047 * s[6] - 0.0046 * s[7]
         + 0.0028 * s[8] + 0.0052 * s[9] + 0.0040 * s[10] + 0.0019 * s[11] - 0.0044 * s[12])
    a0, d0, W = np.radians([a0, d0, W])

    def rz(t):
        return np.array([[np.cos(t), -np.sin(t), 0], [np.sin(t), np.cos(t), 0], [0, 0, 1]])

    def rx(t):
        return np.array([[1, 0, 0], [0, np.cos(t), -np.sin(t)], [0, np.sin(t), np.cos(t)]])

    return rz(a0 + np.pi / 2) @ rx(np.pi / 2 - d0) @ rz(W)


def tdb_minus_utc_s(jd_utc: float) -> float:
    # TAI-UTC leap seconds since 1999 (table), TT = TAI + 32.184 s, TDB ~ TT
    steps = [(2453736.5, 33), (2454832.5, 34), (2456109.5, 35), (2457204.5, 36), (2457754.5, 37)]
    ls = 32
    for jd, v in steps:
        if jd_utc >= jd:
            ls = v
    return ls + 32.184


def cmd_validate() -> None:
    """compare IAU orientation x Horizons vectors with Horizons sub-solar/sub-Earth points"""
    start, stop = "2026-01-01", "2027-01-01"
    errs = {}
    for (body, name), observer in zip(BODIES, ["500@10", "500@399"]):
        sub = table(horizons({
            "COMMAND": "301", "CENTER": observer, "EPHEM_TYPE": "OBSERVER", "START_TIME": start,
            "STOP_TIME": stop, "STEP_SIZE": "7 d", "QUANTITIES": "14", "ANG_FORMAT": "DEG",
            "TIME_TYPE": "UT", "CAL_FORMAT": "JD",
        }))
        vec = fetch_vectors(body, start, stop)
        e = []
        for r in sub:
            jd_utc = float(r[0])
            lon, lat = float(r[3]), float(r[4])
            jd_tdb = jd_utc + tdb_minus_utc_s(jd_utc) / 86400
            k = np.searchsorted(vec[:, 0], jd_tdb)
            k = min(max(k, 1), len(vec) - 1)
            f = (jd_tdb - vec[k - 1, 0]) / (vec[k, 0] - vec[k - 1, 0])
            p = vec[k - 1, 1:4] * (1 - f) + vec[k, 1:4] * f
            v = iau_moon(jd_tdb).T @ (p / np.linalg.norm(p))
            ref = np.array([np.cos(np.radians(lat)) * np.cos(np.radians(lon)),
                            np.cos(np.radians(lat)) * np.sin(np.radians(lon)), np.sin(np.radians(lat))])
            e.append(np.degrees(np.arccos(np.clip(v @ ref, -1, 1))))
        errs[name] = (float(np.mean(e)), float(np.max(e)), len(e))
        print(f"sub-{name.lower()} point, IAU model vs Horizons ({len(e)} dates in 2026): "
              f"mean {np.mean(e) * 60:.2f}', max {np.max(e) * 60:.2f}' (arcmin)")
    (OUT / "validation.json").write_text(json.dumps({k: {"mean_deg": v[0], "max_deg": v[1], "n": v[2]} for k, v in errs.items()}, indent=1))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=2000)
    ap.add_argument("--end", type=int, default=2050)
    ap.add_argument("--validate", action="store_true")
    a = ap.parse_args()
    cmd_fetch(a.start, a.end)
    if a.validate:
        cmd_validate()


if __name__ == "__main__":
    main()
