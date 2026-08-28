#!/usr/bin/env python3
import sys
sys.path.insert(0, "python")
from locations import parse_suggestions, pick_city_match

sample = {
    "suggestions": [
        {
            "address": {
                "fullText": "Татарстан Республика, город Казань",
                "geometry": {"point": {"lat": 55.796289, "lon": 49.108795}},
                "components": {
                    "city": {"name": "Казань", "uid": "93b3df57-4c89-44df-ac42-96f05e9cd3b9"},
                    "province": {"name": "Татарстан Республика"},
                },
            }
        },
        {
            "address": {
                "fullText": "Татарстан Республика, город Казань, проспект Победы",
                "geometry": {"point": {"lat": 55.77351, "lon": 49.0}},
                "components": {
                    "city": {"name": "Казань", "uid": "93b3df57-4c89-44df-ac42-96f05e9cd3b9"},
                    "province": {"name": "Татарстан Республика"},
                },
            }
        },
        {
            "address": {
                "fullText": "город Санкт-Петербург",
                "geometry": {"point": {"lat": 59.93, "lon": 30.31}},
                "components": {"city": {"name": "Санкт-Петербург", "uid": "c2deb16a"}},
            }
        },
        {
            "address": {
                "fullText": "Санкт-Петербург, город Колпино",
                "geometry": {"point": {"lat": 59.74, "lon": 30.59}},
                "components": {
                    "city": {"name": "Колпино", "uid": "1e11"},
                    "province": {"name": "Санкт-Петербург"},
                },
            }
        },
    ]
}

cities = parse_suggestions(sample, 10)
assert len(cities) == 3, cities
assert cities[0]["city"] == "Казань"
match = pick_city_match("Казань", parse_suggestions(sample, 10))
assert match["lat"] == 55.796289
spb = pick_city_match("СПб", [c for c in parse_suggestions(sample, 10) if "Санкт" in c["city"] or c["city"] == "Колпино"])
assert spb["city"] == "Санкт-Петербург", spb
print("locations tests OK")

