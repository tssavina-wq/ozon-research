#!/usr/bin/env python3
"""Long-lived Camoufox session for Ozon composer-api fetch.

Stdout: JSON lines only (bridge protocol).
Stderr: logs.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from urllib.parse import quote

from camoufox.async_api import AsyncCamoufox

# Ensure sibling modules resolve when launched as `python python/browser_service.py`
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from locations import parse_location_current, parse_suggestions, pick_city_match

HOME = "https://www.ozon.ru/"
API = "https://www.ozon.ru/api/composer-api.bx/page/json/v2?url="
CHALLENGE_WAIT_MS = int(os.environ.get("OZON_CHALLENGE_WAIT_MS", "15000"))
NAV_TIMEOUT_MS = int(os.environ.get("OZON_NAV_TIMEOUT_MS", "90000"))
IDLE_TIMEOUT_MS = int(os.environ.get("OZON_IDLE_TIMEOUT_MS", str(10 * 60 * 1000)))
HEADLESS = os.environ.get("OZON_HEADLESS", "true").lower() not in ("0", "false", "no")
GEOIP = os.environ.get("OZON_GEOIP", "false").lower() in ("1", "true", "yes")
CHALLENGE_RE = re.compile(r"antibot|ограничен|доступ", re.I)


def log(*args: object) -> None:
    print("[browser-py]", *args, file=sys.stderr, flush=True)


def respond(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class OzonBrowser:
    def __init__(self) -> None:
        self._cm: AsyncCamoufox | None = None
        self._browser = None
        self._page = None
        self._challenged = False
        self._lock = asyncio.Lock()
        self._idle_task: asyncio.Task | None = None

    def _reset_idle(self) -> None:
        if self._idle_task:
            self._idle_task.cancel()
        self._idle_task = asyncio.create_task(self._idle_shutdown())

    async def _idle_shutdown(self) -> None:
        await asyncio.sleep(IDLE_TIMEOUT_MS / 1000)
        log("idle timeout — closing browser")
        await self.shutdown()

    async def start(self) -> None:
        if self._challenged:
            return

        log("launching Camoufox…")
        opts: dict = {
            "headless": HEADLESS,
            "locale": "ru-RU",
            "geoip": GEOIP,
            "os": "windows",
        }
        proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
        if proxy:
            opts["proxy"] = {"server": proxy}
            log("using proxy", proxy)

        self._cm = AsyncCamoufox(**opts)
        self._browser = await self._cm.__aenter__()
        self._page = await self._browser.new_page()

        log("passing anti-bot challenge…")
        await self._page.goto(HOME, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
        await asyncio.sleep(CHALLENGE_WAIT_MS / 1000)

        title = await self._page.title()
        if CHALLENGE_RE.search(title):
            raise RuntimeError(f"challenge not passed (title: {title})")

        self._challenged = True
        log("challenge passed:", title[:40])

    async def _fetch_json_once(self, path: str) -> dict:
        if not self._challenged:
            await self.start()
        self._reset_idle()

        url = API + quote(path, safe="")
        body = await self._page.evaluate(
            """async (url) => {
                const r = await fetch(url, { headers: { accept: "application/json" } });
                return { status: r.status, text: await r.text() };
            }""",
            url,
        )

        status = body["status"]
        if status != 200:
            raise RuntimeError(f"Ozon returned HTTP {status}")

        return json.loads(body["text"])

    async def fetch_json(self, path: str, retries: int = 1) -> dict:
        async with self._lock:
            for attempt in range(retries + 1):
                try:
                    return await self._fetch_json_once(path)
                except RuntimeError as err:
                    msg = str(err)
                    # Permanent client errors: do not burn a full browser relaunch
                    if "HTTP 404" in msg or "HTTP 400" in msg:
                        raise
                    retryable = (
                        "HTTP 403" in msg
                        or "HTTP 307" in msg
                        or "challenge" in msg.lower()
                        or "TargetClosed" in msg
                        or "closed" in msg.lower()
                    )
                    if attempt < retries and retryable:
                        log(msg, "relaunching session…")
                        await self.shutdown()
                        continue
                    if attempt < retries and "HTTP" not in msg:
                        log("fetch failed, retrying:", err)
                        await self.shutdown()
                        continue
                    raise

        raise RuntimeError("fetch_json exhausted retries")

    async def _post_action(self, action: str, payload: dict) -> dict:
        if not self._challenged:
            await self.start()
        self._reset_idle()
        body = await self._page.evaluate(
            """async ({ action, payload }) => {
                const r = await fetch(`https://www.ozon.ru/api/composer-api.bx/_action/${action}`, {
                    method: 'POST',
                    headers: { accept: 'application/json', 'content-type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                return { status: r.status, text: await r.text() };
            }""",
            {"action": action, "payload": payload},
        )
        status = body["status"]
        if status != 200:
            raise RuntimeError(f"Ozon action {action} returned HTTP {status}: {body['text'][:200]}")
        return json.loads(body["text"])

    async def search_cities(self, query: str, limit: int = 10) -> dict:
        q = str(query or "").strip()
        if not q:
            raise ValueError("query is required (min 1 character)")
        async with self._lock:
            data = await self._post_action("suggest", {"clientName": "ozonWeb", "query": q})
            cities = parse_suggestions(data, limit=limit)
            return {"query": q, "count": len(cities), "cities": cities}

    async def get_location(self) -> dict:
        async with self._lock:
            page = await self._fetch_json_once("/")
            loc = parse_location_current((page.get("location") or {}).get("current"))
            if not loc:
                raise RuntimeError("location not available in composer response")
            return loc

    async def set_city(self, city: str, lat: float | None = None, lng: float | None = None) -> dict:
        """Resolve city via Ozon suggest API, pick a PVZ on the map, confirm."""
        name = str(city or "").strip()
        if not name:
            raise ValueError("city is required")

        async with self._lock:
            if lat is None or lng is None:
                data = await self._post_action("suggest", {"clientName": "ozonWeb", "query": name})
                cities = parse_suggestions(data, limit=10)
                info = pick_city_match(name, cities)
                lat, lng = info["lat"], info["lng"]
                label = info["city"]
            else:
                label = name

            if not self._challenged:
                await self.start()
            self._reset_idle()
            page = self._page
            map_url = f"{HOME}modal/commonDelivery?init=t&lat={lat}&long={lng}&tab=pp&pv=2"
            log("set_city: opening map for", label)
            await page.goto(map_url, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            await asyncio.sleep(5)

            title = await page.title()
            if CHALLENGE_RE.search(title):
                raise RuntimeError(f"challenge during set_city (title: {title})")

            pin_link = await self._resolve_pickup_pin(page, lat, lng)
            if not pin_link:
                raise RuntimeError(f"no pickup points found near {label}")

            await page.goto(HOME.rstrip("/") + pin_link, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            await asyncio.sleep(3)

            btn = page.get_by_test_id("address-edit-confirm-button")
            if await btn.count() == 0:
                btn = page.get_by_role("button", name="Заберу отсюда")
            if await btn.count() == 0:
                raise RuntimeError("pickup confirm button not found")
            await btn.first.click()
            await asyncio.sleep(3)

            await page.goto(HOME, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            await asyncio.sleep(1)

            page_json = await self._fetch_json_once("/")
            loc = parse_location_current((page_json.get("location") or {}).get("current"))
            if not loc:
                raise RuntimeError("location not set after pickup selection")
            log("set_city: ok", label, "→", loc.get("city"))
            return {"ok": True, "requestedCity": label, "location": loc}

    async def _resolve_pickup_pin(self, page, target_lat: float, target_lng: float) -> str | None:
        """Nearest PIN; if Ozon only returns CLUSTER bubbles, zoom into them until a PIN appears."""

        def dist2(m: dict) -> float:
            c = m.get("coordinates") or {}
            la, lo = c.get("latitude"), c.get("longitude")
            if la is None or lo is None:
                return float("inf")
            return (la - target_lat) ** 2 + (lo - target_lng) ** 2

        for depth in range(5):
            markers = await page.evaluate(
                """async () => {
                    const r = await fetch('https://www.ozon.ru/api/composer-api.bx/page/json/v2?url='
                        + encodeURIComponent(location.pathname + location.search));
                    const data = await r.json();
                    const out = [];
                    for (const [k, v] of Object.entries(data.widgetStates || {})) {
                        if (!k.startsWith('addressEditMap')) continue;
                        const amap = JSON.parse(v);
                        for (const m of amap.markerBundle?.mapObjectCollection?.mapObjects || []) {
                            out.push(m);
                        }
                    }
                    return out;
                }"""
            )
            pins = [m for m in markers if m.get("type") == "PIN" and m.get("actionLink")]
            if pins:
                pins.sort(key=dist2)
                return pins[0]["actionLink"]

            clusters = [m for m in markers if m.get("type") == "CLUSTER" and m.get("actionLink")]
            if not clusters:
                return None
            clusters.sort(key=dist2)
            zoom_link = clusters[0]["actionLink"]
            log(f"set_city: zoom cluster depth={depth}", zoom_link[:80])
            await page.goto(HOME.rstrip("/") + zoom_link, wait_until="domcontentloaded", timeout=NAV_TIMEOUT_MS)
            await asyncio.sleep(3)

        return None

    async def shutdown(self) -> None:
        if self._idle_task:
            self._idle_task.cancel()
            self._idle_task = None

        self._challenged = False
        self._page = None
        self._browser = None

        if self._cm is not None:
            try:
                await self._cm.__aexit__(None, None, None)
            except Exception as err:
                log("shutdown error:", err)
            self._cm = None


async def handle_commands() -> None:
    browser = OzonBrowser()
    loop = asyncio.get_running_loop()
    shutting_down = False

    async def stop_browser() -> None:
        nonlocal shutting_down
        if shutting_down:
            return
        shutting_down = True
        await browser.shutdown()

    def on_signal(*_args: object) -> None:
        asyncio.create_task(stop_browser())

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, on_signal)
        except NotImplementedError:
            signal.signal(sig, lambda *_: on_signal())

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break

        line = line.strip()
        if not line:
            continue

        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            cmd = req.get("cmd")

            if cmd == "fetch":
                data = await browser.fetch_json(req["path"], retries=int(req.get("retries", 1)))
                respond({"id": req_id, "ok": True, "data": data})
            elif cmd == "warmup":
                await browser.start()
                respond({"id": req_id, "ok": True, "data": {"ready": True}})
            elif cmd == "get_location":
                data = await browser.get_location()
                respond({"id": req_id, "ok": True, "data": data})
            elif cmd == "search_cities":
                data = await browser.search_cities(req["query"], limit=int(req.get("limit", 10)))
                respond({"id": req_id, "ok": True, "data": data})
            elif cmd == "set_city":
                data = await browser.set_city(
                    req["city"],
                    lat=req.get("lat"),
                    lng=req.get("lng"),
                )
                respond({"id": req_id, "ok": True, "data": data})
            elif cmd == "shutdown":
                await stop_browser()
                respond({"id": req_id, "ok": True})
                break
            else:
                respond({"id": req_id, "ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as err:
            respond({"id": req_id, "ok": False, "error": str(err)})

    await stop_browser()


def main() -> None:
    try:
        asyncio.run(handle_commands())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
