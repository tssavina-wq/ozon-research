# Ozon location helpers — parse composer/suggest JSON, no hardcoded city lists.

from __future__ import annotations


def normalize_key(text: str) -> str:
    return " ".join(str(text or "").strip().lower().replace("ё", "е").split())


def parse_location_current(current: dict | None) -> dict | None:
    if not current:
        return None
    city = current.get("city") or current.get("name")
    region = None
    full = current.get("fullName") or ""
    if full.startswith("{{{"):
        inner = full.split("|")[0].removeprefix("{{{").strip()
        parts = [p.strip() for p in inner.split(",")]
        if len(parts) >= 2:
            region = parts[1]
    elif "," in full:
        parts = [p.strip() for p in full.split(",")]
        if len(parts) >= 2 and parts[0] in ("Россия", "Russia"):
            region = parts[1]
    return {
        "city": city,
        "region": region,
        "pickupAddress": full if full and not full.startswith("{{{") else None,
    }


def _region_from_components(components: dict) -> str | None:
    for key in ("province", "region", "area", "country"):
        comp = components.get(key) or {}
        name = comp.get("name")
        if name and key != "country":
            return name
    return None


def parse_suggestion(item: dict) -> dict | None:
    addr = item.get("address") or item
    if not addr:
        return None
    components = addr.get("components") or {}
    city_comp = components.get("city") or components.get("locality") or {}
    city = city_comp.get("name") or item.get("displayAddressValue", "").split(",")[0].strip()
    if not city:
        return None
    point = (addr.get("geometry") or {}).get("point") or {}
    lat = point.get("lat")
    lng = point.get("lon")
    if lat is None or lng is None:
        return None
    return {
        "label": addr.get("fullText") or addr.get("formattedFullText") or city,
        "city": city,
        "region": _region_from_components(components),
        "uid": city_comp.get("uid") or addr.get("uid") or None,
        "lat": lat,
        "lng": lng,
    }


def parse_suggestions(data: dict, limit: int = 10) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()
    for item in data.get("suggestions") or []:
        parsed = parse_suggestion(item)
        if not parsed:
            continue
        key = normalize_key(parsed["city"])
        if key in seen:
            continue
        seen.add(key)
        out.append(parsed)
        if len(out) >= limit:
            break
    return out


def pick_city_match(query: str, suggestions: list[dict]) -> dict:
    if not suggestions:
        raise ValueError(f"no cities found for {query!r}")
    q = normalize_key(query)
    exact = [s for s in suggestions if normalize_key(s["city"]) == q]
    if exact:
        # Prefer city-center entry (shortest label among same city).
        return min(exact, key=lambda s: len(s.get("label") or ""))
    if len(suggestions) == 1:
        return suggestions[0]
    labels = ", ".join(s["city"] for s in suggestions[:8])
    raise ValueError(f"ambiguous city {query!r}; pick one of: {labels}")
