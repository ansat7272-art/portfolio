"""Build the curated list of Kazakhstan cities from Overture localities."""
import json, math, os, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "data")

# Overture name fixes / duplicates
RENAME = {
    "город Жанаозен": "Жанаозен",
    "Абайская Г.А.": "Абай",
    "Шемонаихинская городская администрация": "Шемонаиха",
    "Байконыр Г.А.": "Байконур",
    "Арысь": "Арыс",
}
KK_FIX = {"Шахтинск": "Шахтинск", "Абай": "Абай", "Шемонаиха": "Шемонаиха", "Байконур": "Байқоңыр", "Жанаозен": "Жаңаөзен"}
SKIP = {"Каскеленская городская администрация", None}
# towns that officially have city status (or are well known) but are not class=city in Overture
EXTRA = {"Балхаш", "Щучинск", "Кандыагаш", "Хромтау", "Алга", "Байконыр Г.А.", "Ленгер", "Алатау", "Эмба", "Есиль", "Каркаралинск"}

TR = dict(zip("абвгдеёжзийклмнопрстуфхцчшщъыьэюяәғқңөұүһі",
              ["a","b","v","g","d","e","e","zh","z","i","y","k","l","m","n","o","p","r","s","t","u","f",
               "kh","ts","ch","sh","shch","","y","","e","yu","ya","a","g","k","n","o","u","u","h","i"]))


def translit(s):
    out = "".join(TR.get(ch, TR.get(ch.lower(), ch)) if ch.lower() in TR else ch for ch in s.lower())
    out = re.sub(r"[^a-z0-9]+", "-", out).strip("-")
    return "-".join(w.capitalize() for w in out.split("-"))


def load():
    rows = json.load(open(os.path.join(DATA, "localities.json")))
    seen, out = set(), []
    for r in rows:
        ru = r["ru"]
        if ru in SKIP:
            continue
        if not (r["cls"] == "city" or ru in EXTRA):
            continue
        ru = RENAME.get(ru, ru)
        key = (ru, round(r["lon"], 2), round(r["lat"], 2))
        if ru in seen:
            continue
        seen.add(ru)
        kk = KK_FIX.get(ru, r["kk"] or ru)
        slug = translit(ru)
        out.append(dict(slug=slug, ru=ru, kk=kk, en=r["en"], pop=r["pop"], lon=r["lon"], lat=r["lat"],
                        region=r["region"]))
    out.sort(key=lambda r: -r["pop"])
    return out


def fetch_halfsize_km(pop):
    """Half-size of the data window around the centre (generous; the plate is computed later)."""
    r_built = max(2.5, 1.6 * math.sqrt(max(pop, 1000) / 1e4))
    return 2.1 * r_built


def bbox(c, km):
    dlat = km / 111.0
    dlon = km / (111.32 * math.cos(math.radians(c["lat"])))
    return (c["lon"] - dlon, c["lat"] - dlat, c["lon"] + dlon, c["lat"] + dlat)


if __name__ == "__main__":
    cs = load()
    for c in cs:
        print(c["slug"], c["ru"], c["kk"], c["pop"], round(fetch_halfsize_km(c["pop"]), 1))
    print(len(cs))
    json.dump(cs, open(os.path.join(DATA, "cities.json"), "w"), ensure_ascii=False, indent=1)
