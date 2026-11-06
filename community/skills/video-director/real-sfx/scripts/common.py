"""Shared helpers: skill paths, config, role tagging, ffmpeg PCM decoding."""
import array
import json
import math
import os
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

SKILL_DIR = Path(__file__).resolve().parent.parent
AUDIO_EXT = {".wav", ".mp3", ".flac", ".aif", ".aiff", ".ogg", ".m4a", ".aac", ".opus"}
SKIP_DIRS = {"__macosx", ".git", "node_modules"}      # archive leftovers, never sound libraries


def is_sound_file(path):
    """An audio file that really is one: not a macOS AppleDouble stub ('._name.wav': a few hundred bytes of
    metadata that every unzip from a Mac leaves behind) and not inside an archive-leftover folder."""
    p = Path(path)
    if p.suffix.lower() not in AUDIO_EXT or p.name.startswith("._"):
        return False
    return not any(part.lower() in SKIP_DIRS for part in p.parts)


_MOJIBAKE = re.compile("[╒-╬▀-▓]")        # box-drawing characters = UTF-8 bytes shown as CP437


def fix_mojibake(text):
    """'╨╝╨╡╨┤╨╗╨╡╨╜╨╜╨░╤Å' -> 'медленная'. A zip made on a Mac stores UTF-8 names without the flag and Windows
    unpacks them as CP437: the file on disk then has a garbled name, while a catalog written at the source has the
    right one. Returns the text unchanged when it does not look garbled or does not decode cleanly."""
    s = str(text)
    if not _MOJIBAKE.search(s):
        return s
    try:
        return s.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return s


def nfc(text):
    """Composed form. macOS writes 'й' as 'и' + a combining mark, which breaks every Russian word match."""
    return unicodedata.normalize("NFC", str(text))


def show_name(path):
    """A file name for people to read: a garbled CP437 name repaired, composed form."""
    return nfc(fix_mojibake(Path(str(path)).name))


_CH_CACHE = {}


def channel_count(path):
    """Channels of the first audio stream of a file (ffprobe); 2 when it cannot be told."""
    k = str(path)
    if k not in _CH_CACHE:
        try:
            r = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                                "stream=channels", "-of", "csv=p=0", k], capture_output=True, text=True)
            _CH_CACHE[k] = int(r.stdout.strip().split(",")[0])
        except Exception:
            _CH_CACHE[k] = 2
    return _CH_CACHE[k]


def stereo_fmt(path, rate=48000):
    """The head of a filter chain that makes `path` a stereo stream at `rate` WITHOUT changing its level. ffmpeg's
    own mono -> stereo (aformat, -ac 2) takes 3 dB off: a mono voice stem, a mono library sound and a mono synth
    stem were all 3 dB under what the plan, the gain fit and the subtraction assumed."""
    pre = "pan=stereo|c0=c0|c1=c0," if channel_count(path) == 1 else ""
    return f"{pre}aformat=sample_rates={rate}:channel_layouts=stereo"


def _decode_text(b):
    """UTF-8 with or without a BOM, or UTF-16 (what Windows PowerShell 5.1 writes with `>` and Out-File)."""
    if b.startswith(b"\xef\xbb\xbf"):
        return b[3:].decode("utf-8", errors="replace")
    if b[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return b.decode("utf-16", errors="replace")
    return b.decode("utf-8", errors="replace")


def read_text_any(path):
    """The text of a file whatever tool wrote it (a BOM in front of the JSON is a JSONDecodeError otherwise)."""
    return _decode_text(Path(path).read_bytes())


def read_stdin_text():
    return _decode_text(sys.stdin.buffer.read())


def load_json(path):
    return json.loads(read_text_any(path))


def norm_path(p):
    """A Git-Bash / MSYS path ('/e/proj/a.wav') written by hand on Windows: Python there wants 'E:/proj/a.wav'."""
    s = str(p)
    if os.name == "nt":
        m = re.match(r"^/([a-zA-Z])/(.*)$", s)
        if m and not Path(s).exists():
            return f"{m.group(1).upper()}:/{m.group(2)}"
    return s

# Ordered rules. A sound gets every role whose pattern matches "<folder path> / <file name>";
# the first match is its primary role. Folder names are EN and RU, so patterns cover both.
ROLE_RULES = [
    ("error",    r"error|ошибк|alarm|тревог|warning|fail"),
    ("click",    r"щелч|\bsnap\b"),   # before whoosh: "Щелчок перехода кадров" is a click, not a swoosh
    ("glitch",   r"glitch|глитч|помех|interference|static|vhs|distort"),
    ("sub_drop", r"sub ?drop|bass ?drop|басс|earthquake|low[- ]end|rumble|deep impact|abyss"),
    ("hit",      r"\bhit\b|impact|punch|slam|braaam|stinger|удар|thud|boom|cinematic hits|transient|expld|explosion|\bcrack|shatter|drum end"),
    ("design",   r"dsgn|b00m|brute force|scream|sustain"),
    ("riser",    r"riser|\brise\b|rising|build ?up|swell|ascend|glide up|reverse"),
    ("whoosh",   r"wh?oo?sh|swish|swoosh|\brush\b|transition|переход|flick|swipe|blitz|sweep|tear|slide|burst|wrap|\[t\]|3d box|bounce|zoom|shake|\bpan\b|perspective|stretch|\bsplit\b|blur|parallax|multiscreen|light leaks|warp"),
    ("cartoon",  r"cartoon"),
    ("vehicle",  r"transportation|\bcar\b|motorcycle|\bbike|airport|wiper|tyre|road|scooter"),
    ("camera",   r"camera|shutter|flash|projector|проектор|плен|film"),
    ("click",    r"click|клик|mouse|мыш|нажати|button|\btap\b|keyboard|клавиатур|клавиаутр|typing"),
    ("ui",       r"\bui\b|interface|notification|уведомл|icon|иконк|\bbell|колокольч|chime|\bping|\bpop\b|bubble|пузыр|bleep|beep|success|\bding\b|incoming|message|\bsent\b|dialing|phone|ringing|time over|gear dial"),
    ("meme",     r"laugh|giggl|bruh|\bsus\b|trap|gunshot|\bgun\b|\bwow\b|oh no|yeah|yea hoe|\bhey\b|\bkid|duck|censor|loser|chant|hood|drank|turnt|uhhh|\bcaw|vroom|\bdrill\b|satisfied|edit sound|shing|generic sound|tritone|certified"),
    ("data",     r"\bdata\b|данн|digit|цифр|computer|compute|scan|hologram"),
    ("paper",    r"paper|бумаг|\bpage|страниц|book|книг|письм|pencil|карандаш|tape|peel|seal"),
    ("glass",    r"glass|стекл|crystal"),
    ("coin",     r"coin|монет|деньги|касса|\bcash|money|кэш|кеш"),
    ("ambience", r"ambien|backgrou|nature|\bcity|crowd|street|traffic|\bwind|\brain|fire|crackl|campfire|space|texture|atmo|birds|waves|river|waterfall|beach|cricket|seagull|forest|shore|\blake\b|\bdog"),
    ("foley",    r"foley|\bdoor|chair|drawer|creak|cooler|plastic|пластик|clock|часы|часов|курант|neon|неон|шипени|hiss|keys|footstep|splash|dragged|debris|metal|squeak|lighter|jump into|throwing stones|balloon|knock|typewriter|heartbeat"),
    ("scifi",    r"sci-?fi|alien|hover|machine|\bship|engine|siren|galactic|futur"),
    # secondary roles: they never take the primary place from the rules above, they only make a sound findable
    # by what it is (a bubble pop is "ui" for the old rules and "pop" here)
    ("pop",      r"\bpops?\b|plop|bubble|пузыр|\bпоп|клоп|блоп"),
    ("chime",    r"chime|\bbells?\b|sparkle|twinkle|shimmer|\bding\b|harp|glock|music ?box|колокольч|куранты|дзынь|блест"),
    ("typing",   r"typing|keyboard|keystroke|typewriter|клавиатур|клавиаутр|печат|клавиш|клавы|клаве"),
    ("water",    r"water|splash|drip|droplet|\bpour|faucet|вода|воды|капл|всплеск"),
]
_COMPILED = [(role, re.compile(rx, re.I)) for role, rx in ROLE_RULES]

# Peak level each role is normalised to before the per-cue gain_db offset (dBFS).
ROLE_TARGET_PEAK_DB = {
    "hit": -4, "sub_drop": -4, "whoosh": -9, "riser": -12, "glitch": -12, "error": -10,
    "click": -14, "ui": -14, "data": -14, "camera": -10, "paper": -12, "glass": -10,
    "coin": -12, "ambience": -24, "foley": -12, "scifi": -12, "cartoon": -12, "vehicle": -18, "design": -6, "meme": -8,
    "pop": -14, "chime": -13, "typing": -14, "water": -14,
    "atmosphere": -24, "granular": -12, "music_transition": -12,
    "default": -10,
}
# Where in the sound the moment of the video should land.
ROLE_ANCHOR = {"click": "start", "ui": "start", "ambience": "start", "vehicle": "start",
               "pop": "start", "typing": "start", "water": "start"}   # everything else: loudest point on the moment;
# riser stays on "peak" too, because many risers decay or ring out long before the end of the file

# A sorted pack (catalog.json / catalog.csv at its root) already says what each sound is: its type was taken from the
# folder it came from. That is more reliable than a pattern over a file name, so it decides the primary role.
PACK_TYPE_ROLES = {
    "whoosh": ["whoosh"], "impact": ["hit"], "riser": ["riser"], "pop": ["pop", "ui"], "chime": ["chime", "ui"],
    "ui": ["ui"], "click": ["click"], "typing": ["typing"], "error": ["error"], "camera": ["camera"],
    "paper": ["paper"], "glass": ["glass"], "cartoon": ["cartoon"], "foley": ["foley"], "water": ["water"],
    "ambience": ["ambience"], "nature": ["foley"], "glitch": ["glitch"], "other": [],
    # types the sorted library Sounds_by_tag has and the first pack did not: each is a role of its own, found by
    # --role NAME and never picked for a cue that asks for another role (granular textures are not whooshes)
    "atmosphere": ["atmosphere"], "granular": ["granular"], "music_transition": ["music_transition"],
    "power": ["power"], "scifi": ["scifi"], "voice": ["voice"],
}
# The sorter's coarse type is wrong for some sources (a white-noise loop filed under "impact", broom sweeps under
# "nature"). The words of the source path decide first: (pattern, roles that replace the pack type's roles, the pack
# types this correction is allowed to touch). A whoosh keeps its role even when its name says "fire".
SOURCE_ROLE_OVERRIDES = [
    (r"static|white noise|tv tuning|ear ringing|creepy|помех|глитч|glitch", ["glitch", "ambience"],
     ("impact", "nature", "other", "foley", "ambience")),
    (r"water ?drop|faucet|dripping|капл|\bвода\b", ["water"], ("impact", "nature", "other", "foley", "water")),
    # a body falling is foley that can serve as a dark hit (not first in line when a hit is asked for)
    (r"body ?fall|thud|падение тела|lego|лего", ["foley", "hit"], ("impact", "nature", "other", "foley")),
    (r"sword ?hit", ["hit", "foley"], ("impact", "nature", "other", "foley")),
    (r"\bfire\b|огонь|acid|bubbling|crackl|ambien|эмбиент|forest|\bwind\b|ветер\b", ["ambience"],
     ("nature", "other", "impact")),
    (r"drum ?fill|барик", ["hit"], ("pop", "other", "impact")),
    (r"digital|диджитал|data ?processing|sci ?fi", ["ui", "data"], ("ui", "other")),
]
_OVERRIDES = [(re.compile(rx, re.I), roles, set(types)) for rx, roles, types in SOURCE_ROLE_OVERRIDES]
_SECONDARY = ("pop", "chime", "typing", "water", "glass", "coin")


def roles_for_catalog(pack_type, text):
    """Roles of a sound that comes with a catalog: the pack type, corrected by the words of its source path where
    the type is a known misfit. The first role is the primary one."""
    ptype = str(pack_type).lower()
    base = list(PACK_TYPE_ROLES.get(ptype, []))
    low = nfc(text).lower().replace("_", " ")
    for rx, roles, types in _OVERRIDES:
        if ptype in types and rx.search(low):
            base = roles + [r for r in base if r not in roles]
            break
    if not base or ptype in ("other", "ui", "click", "pop", "chime", "typing"):
        base += [r for r in tag_roles(low) if r in _SECONDARY and r not in base]
    return base


def config_path():
    """REAL_SFX_CONFIG lets tests and other setups point at their own config without touching the skill."""
    env = os.environ.get("REAL_SFX_CONFIG")
    return Path(env) if env else SKILL_DIR / "config.json"


def load_config():
    p = config_path()
    if not p.exists():
        sys.exit(f"config not found: {p}  (run: python scripts/setup.py --help)")
    return json.loads(read_text_any(p))


def index_path(cfg=None):
    env = os.environ.get("REAL_SFX_INDEX")
    if env:
        return Path(env)
    cfg = cfg or load_config()
    p = Path(cfg.get("index_path", "library_index.json"))
    return p if p.is_absolute() else SKILL_DIR / p


def require_tools(*names):
    """Stop early with a clear message instead of a cryptic failure in the middle of a run."""
    names = names or ("ffmpeg", "ffprobe")
    missing = [n for n in names if shutil.which(n) is None]
    if missing:
        sys.exit("missing tools in PATH: " + ", ".join(missing) +
                 ". Install FFmpeg (https://ffmpeg.org/download.html) and reopen the terminal.")


def venv_python():
    """The Python of the skill's own venv (numpy, onnxruntime: `listen.py install`), or None. REAL_SFX_VENV_PYTHON names
    one explicitly (a working copy has no venv of its own)."""
    env = os.environ.get("REAL_SFX_VENV_PYTHON")
    if env and Path(env).exists():
        return Path(env)
    p = SKILL_DIR / "vendor" / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return p if p.exists() else None


def events_track(sheet, track):
    """The track the SOUNDS of a film are judged on. A film with a bed (bed.py) has a second track without it, which
    mix.py writes and names in the resolved cues: a bed fills every window of the full track, so the onset of a sound is
    not clear in it, and a sound the render lost would not be missed."""
    p = ((sheet or {}).get("bed") or {}).get("track_nobed") if isinstance(sheet, dict) else None
    if p and Path(str(p)).exists():
        return str(p)
    return track


def measure_loudness(path):
    """Integrated loudness (LUFS), loudness range (LU) and true peak (dBFS) of an audio file via ebur128."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn",
                        "-af", "ebur128=peak=true", "-f", "null", "-"], capture_output=True, text=True,
                       errors="replace")
    tail = r.stderr.split("Summary:")[-1]
    def grab(label):
        m = re.search(label + r":\s+(-?[\d.]+|-inf)", tail)
        if not m or m.group(1) == "-inf":
            return None
        return float(m.group(1))
    return {"lufs": grab("I"), "lra": grab("LRA"), "true_peak": grab("Peak")}


# Russian words of folder and file names -> English search words (the libraries of this skill's users mix both)
RU_EN = {
    "переход": "transition", "перехода": "transition", "переходов": "transition", "помеха": "interference glitch static",
    "глитч": "glitch", "эффект": "effect", "эффектом": "effect", "нажатие": "press click tap", "мышкой": "mouse",
    "мышка": "mouse", "техно": "techno", "ошибка": "error", "техническая": "technical", "длительный": "long",
    "быстрый": "fast quick", "быстро": "fast quick", "компьютерные": "computer", "данные": "data", "басс": "bass",
    "иконку": "icon", "бумага": "paper", "бумаги": "paper", "бумаге": "paper", "лист": "sheet paper page",
    "листание": "page flip paper", "страниц": "page", "письмо": "letter paper", "книга": "book", "книги": "book",
    "дроп": "drop", "битбокс": "beatbox", "разбитое": "broken", "стекло": "glass", "именные": "named custom",
    "монтаже": "editing", "монтажа": "editing", "нарезки": "cut editing", "программе": "program", "кадров": "frames",
    "щелчок": "click", "клик": "click", "стандартно": "standard", "стандартный": "standard", "тандартный": "standard",
    "перевёртывания": "flip turn", "процесс": "process", "монета": "coin", "монеты": "coin", "мелочь": "coins change",
    "касса": "cash register", "деньги": "money cash", "падение": "fall drop", "большой": "big large",
    "смятая": "crumpled paper", "мнется": "crumple paper", "энергии": "energy", "камеры": "camera",
    "затвора": "shutter", "пластик": "plastic", "лента": "tape ribbon", "кинопроектора": "film projector",
    "неон": "neon", "лампа": "lamp", "уведомление": "notification", "медленный": "slow", "клавиатура": "keyboard typing",
    "клавиаутра": "keyboard typing", "колокольчик": "bell chime", "куранты": "clock chime bell", "поп": "pop",
    "клоп": "clop pop", "карандашом": "pencil", "карандаш": "pencil", "карандашем": "pencil",
    "черчение": "drawing pencil", "маркером": "marker", "маркер": "marker", "сигнал": "signal beep",
    "тревоги": "alarm alert", "будильника": "alarm clock", "установка": "install setup", "установке": "install setup",
    "цифр": "numbers digits", "лопаются": "pop burst", "пузырьки": "bubbles", "пленочныи": "film",
    "проигрыватель": "player turntable", "проигрывателем": "player turntable", "рвется": "rip tear",
    "разорванная": "torn rip", "шипение": "hiss", "маленький": "small little", "глубокий": "deep", "огня": "fire",
    "огненный": "fire", "шар": "ball fireball", "двери": "door", "космические": "space sci-fi", "магия": "magic",
    "металлический": "metal metallic", "меч": "sword", "высокий": "high", "глухой": "dull muffled", "работа": "work",
    "часов": "clock watch", "любимый": "favorite",
    # the montage pack (folder names of its sources)
    "абстрактные": "abstract", "алмазов": "diamonds", "арфа": "harp", "арфы": "harp", "бег": "run running fast",
    "бзыньк": "ding twang", "блест": "sparkle glitter shine", "быстрая": "fast quick", "быстрый": "fast quick",
    "быстро": "fast quick", "ветер": "wind", "ветром": "wind", "взлетный": "takeoff rising", "влажным": "wet",
    "вода": "water", "воды": "water", "восстановления": "restore heal health", "вспышка": "flash",
    "вспышки": "flash", "вуш": "whoosh swoosh", "вуши": "whoosh swoosh", "выбор": "select choice",
    "выдох": "exhale breath", "громко": "loud", "даунер": "downer down", "диджитал": "digital", "дзынь": "ding chime bell",
    "долгая": "long", "заставок": "intro logo title", "зачеркивание": "strikethrough scribble", "импакт": "impact",
    "импактные": "impact", "камера": "camera", "камерный": "camera", "камеры": "camera", "кар": "caw crow",
    "карандашей": "pencil", "карандашом": "pencil", "клаве": "keyboard", "клавиш": "keyboard keys",
    "клавы": "keyboard typing", "клики": "click", "кнопки": "button", "коробка": "box", "коробку": "box",
    "короткая": "short", "короткий": "short", "кровавые": "bloody blood", "кровь": "blood squish", "круг": "circle",
    "кэш": "cash", "лазер": "laser", "лего": "lego plastic bricks", "медленная": "slow", "меню": "menu",
    "металлический": "metal metallic", "мягкая": "soft", "мягкий": "soft", "мять": "crumple", "напор": "pressure rush",
    "начале": "start beginning", "объем": "volume spacious", "объемный": "volume spacious", "одежда": "clothes cloth rustle",
    "очень": "very", "отказано": "denied rejected", "переворачивания": "flip turn page", "печатания": "typing",
    "плоский": "flat", "подметания": "sweeping broom sweep", "подсчет": "counting", "поезд": "train",
    "полотенцем": "towel", "попы": "pop bubble plop", "порезы": "cuts slash stab", "появления": "appear appearance",
    "пузырь": "bubble", "разбитого": "broken shattered", "разрыва": "tear rip", "райзеры": "riser risers",
    "ракеткой": "racket", "растении": "plants", "растущих": "growing plants vegetation", "редко": "rare sparse",
    "резина": "rubber stretch", "резкий": "sharp abrupt", "ртом": "mouth", "рукой": "hand", "ручкой": "pen",
    "свайп": "swipe", "свист": "whistle", "сердце": "heart heartbeat", "сильный": "strong powerful",
    "скинули": "dropped thrown", "скролл": "scroll", "слайд": "slide", "средний": "medium", "старой": "old vintage",
    "стекла": "glass", "сухим": "dry", "твердая": "hard", "тела": "body", "тихий": "quiet soft", "тихо": "quiet",
    "тяжелую": "heavy", "тяжелый": "heavy", "удар": "hit punch impact", "упала": "fell", "феи": "fairy magic",
    "флешбек": "flashback", "ходьба": "walk footsteps", "хит": "hit impact", "хиты": "hit impact",
    "хоррорах": "horror", "хп": "hp health", "цензура": "censor beep", "цепью": "chain", "цифровой": "digital",
    "шкатулки": "music box", "шум": "noise", "щелк": "click snap", "эмбиент": "ambient ambience", "эхо": "echo",
    "диджитал": "digital", "другое": "other", "морф": "morph", "огонь": "fire", "меч": "sword", "магия": "magic",
    "крылья": "wings flap flutter", "карандаши": "pencils pencil", "бумагу": "paper", "падение": "fall drop",
}


def aliases_for(text):
    """English search words for the Russian words in a folder + file name ('Пластик 2' -> plastic).
    Endings are tolerated: 'карандашей' finds 'карандаш' (a known word followed by at most three letters)."""
    glossary = _glossary()
    out = set()
    for tok in re.findall(r"[а-я]+", nfc(text).lower().replace("ё", "е")):
        hit = glossary.get(tok)
        if hit is None:
            best = max((k for k in glossary if len(k) >= 4 and tok.startswith(k) and len(tok) - len(k) <= 3),
                       key=len, default=None)
            hit = glossary.get(best) if best else None
        if hit:
            out.update(hit.split())
    return sorted(out)


_GLOSSARY = {}


def _glossary():
    """RU_EN with 'ё' folded to 'е' (names are folded the same way before lookup)."""
    if not _GLOSSARY:
        _GLOSSARY.update({k.replace("ё", "е"): v for k, v in RU_EN.items()})
    return _GLOSSARY


def tag_roles(text):
    found = []
    text = nfc(text)
    for role, rx in _COMPILED:
        if rx.search(text) and role not in found:
            found.append(role)
    return found


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", **kw)


def decode_mono(path, rate=16000, channel=None):
    """Decode any audio file to mono int16 samples via ffmpeg (so mp3/wav/flac all work). `channel` 0 or 1 takes that
    channel of a stereo file instead of the sum of both."""
    af = ["-af", f"pan=mono|c0=c{int(channel)}"] if channel is not None else []
    p = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-vn"] + af + ["-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
        capture_output=True,
    )
    a = array.array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 2 * 2])
    return a, rate


_INV = {}


def decode_sound(path, rate=16000):
    """decode_mono for ONE SOUND (a library file, a slice). When its channels are in opposite phase (correlation under
    -0.3) the mono sum is silence and every measure made on it is wrong (peak time, loudness, character), so the louder
    channel is taken instead: that is also what mix.py plays for such a sound. The channel used (or None) stays in
    _INV[path] for analyse_sound to record as `mono_ref`."""
    k = str(path)
    if k not in _INV:
        ch = None
        if channel_count(path) == 2:
            try:
                _, corr = stereo_peak(path, rate)
                if corr is not None and corr < -0.3:
                    ch = louder_channel(path, rate)
            except Exception:
                ch = None
        _INV[k] = ch
    if _INV[k] is not None:
        a, r = decode_mono(path, rate, channel=_INV[k])
        if a:
            return a, r
    return decode_mono(path, rate)


def native_peak_db(path):
    """Sample peak (dBFS) of the whole file at its own rate and all channels, as ffmpeg's volumedetect sees it.
    A 16 kHz look under-reads the peak of a click by up to 7 dB."""
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn",
                        "-af", "volumedetect", "-f", "null", "-"], capture_output=True, text=True, errors="replace")
    m = re.search(r"max_volume:\s*(-?[\d.]+) dB", r.stderr)
    return float(m.group(1)) if m else None


def voice_share(path):
    """{'speech': share, 'music': share, 'seconds': s} of a file as YAMNet hears it (ears level 2), or None when
    the model is not installed."""
    lis = Path(__file__).parent / "listen.py"
    try:
        r = subprocess.run([sys.executable, str(lis), "voice", str(path)], capture_output=True, text=True,
                           timeout=300)
        out = r.stdout.strip().splitlines()
        if r.returncode == 0 and out and out[-1].startswith("{"):
            return json.loads(out[-1])
    except Exception:
        pass
    return None


def stereo_peak(path, rate=16000):
    """(largest channel peak 0..32768, correlation of left and right). The mono sum hides a loud sound whose channels
    are in opposite phase: its mono peak looks 10 dB lower than what actually leaves the speakers."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "2", "-ar", str(rate),
                        "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 4 * 4])
    if not a:
        return None, None
    left, right = a[0::2], a[1::2]
    pk = max(max(left), -min(left), max(right), -min(right)) or 1
    sl = sum(v * v for v in left)
    sr = sum(v * v for v in right)
    corr = sum(l_ * r_ for l_, r_ in zip(left, right)) / math.sqrt(sl * sr) if sl > 0 and sr > 0 else 1.0
    return pk, corr


def stereo_samples(path, rate=16000):
    """Both channels of any audio file as two int16 arrays at `rate` (a mono file gives two identical ones)."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "2", "-ar", str(rate),
                        "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 4 * 4])
    return a[0::2], a[1::2]


def _fold(ll, rr, lr, n):
    """(loss in dB, level in dBFS) of a stretch of a stereo pair, from its sums of squares and of products. None for the
    loss when the stretch is silent (under -65 dBFS): there is nothing to lose."""
    tot = ll + rr
    if n <= 0 or tot <= 0:
        return None, -120.0
    lvl = 10 * math.log10(tot / (2.0 * n) / (32768.0 * 32768.0))
    if lvl < -65.0:
        return None, lvl
    c = 2.0 * lr / tot
    return max(0.0, -10 * math.log10(max(1e-4, (1.0 + c) / 2.0))), lvl


def fold_report(path, windows=(), rate=16000):
    """What a mono playback (a phone speaker, one earbud, a laptop, a mono mix of a platform) does to a stereo file.
    Folding adds the two channels: identical channels lose nothing, unrelated ones lose 3 dB, channels in opposite
    phase cancel. The loss is the power of the pair over the power of its sum, -10 log10((1 + c) / 2) with
    c = 2<LR> / (<LL> + <RR>), 0 .. 40 dB.
    Returns {"loss_db": whole file (None when silent), "level_db": its level, "rows": [(loss_db, level_db) per window
    of seconds]}."""
    from operator import mul
    left, right = stereo_samples(path, rate)
    n = min(len(left), len(right))
    if n == 0:
        return {"loss_db": None, "level_db": None, "rows": [(None, -120.0) for _ in windows]}

    def sums(i0, i1):
        a, b = left[i0:i1], right[i0:i1]
        return sum(map(mul, a, a)), sum(map(mul, b, b)), sum(map(mul, a, b)), len(a)

    whole = _fold(*sums(0, n))
    rows = []
    for w0, w1 in windows:
        i0, i1 = max(0, int(w0 * rate)), min(n, int(w1 * rate))
        rows.append(_fold(*sums(i0, i1)) if i1 > i0 else (None, -120.0))
    return {"loss_db": whole[0], "level_db": whole[1], "rows": rows}


def fold_cues(track, cues, rate=16000):
    """The mono loss of the stretch each placed sound occupies on the SFX track: (report, [(cue, loss_db or None,
    level_db)]). A stretch is the first 0.15..0.8 s of the sound as placed ('start' and 'seg' of a resolved sheet)."""
    wins = []
    for c in cues:
        s0 = c.get("start", c["t"])
        wins.append((s0, s0 + min(0.8, max(0.15, c.get("seg") or 0.4))))
    rep_ = fold_report(track, wins, rate)
    return rep_, [(c, r[0], r[1]) for c, r in zip(cues, rep_["rows"])]


def mono_drop(path):
    """How many LU a mono playback takes off a two-channel file: its loudness minus the loudness of both channels
    replaced by their average (BS.1770, gated). A wide mix loses 1..3 LU; a part in opposite phase makes it more.
    None for a file that is not two-channel."""
    if channel_count(path) != 2:
        return None
    st = measure_loudness(path).get("lufs")
    r = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path), "-vn", "-af",
                        "pan=stereo|c0=0.5*c0+0.5*c1|c1=0.5*c0+0.5*c1,ebur128", "-f", "null", "-"],
                       capture_output=True, text=True, errors="replace")
    m = re.search(r"I:\s+(-?[\d.]+) LUFS", r.stderr.split("Summary:")[-1])
    if st is None or not m:
        return None
    return round(st - float(m.group(1)), 2)


_LOUD_CH = {}


def louder_channel(path, rate=16000):
    """0 or 1: the channel of a stereo file with the most energy. A sound whose channels are in opposite phase is
    folded to it (one channel on both sides keeps the sound; a sum would cancel it)."""
    from operator import mul
    k = str(path)
    if k not in _LOUD_CH:
        l_, r_ = stereo_samples(path, rate)
        _LOUD_CH[k] = 0 if sum(map(mul, l_, l_)) >= sum(map(mul, r_, r_)) else 1
    return _LOUD_CH[k]


def onsets(path, hop=0.005, rise_db=8.0, min_gap=0.045):
    """Sharp level rises in a recording (key down, knock, click, tick) as [(time, level dB under the recording
    peak)] and the length of the recording."""
    a, rate = decode_sound(path, 16000)
    w = int(rate * hop)
    env = []
    for i in range(0, len(a) - w + 1, w):
        e = math.sqrt(sum(v * v for v in a[i:i + w]) / w)
        env.append(20 * math.log10(e / 32768.0) if e > 0 else -100.0)
    if not env:
        return [], 0.0
    pk = max(env)
    out, last = [], -1.0
    for i in range(2, len(env)):
        if env[i] > pk - 28 and env[i] - max(env[i - 2], env[i - 1]) >= rise_db and i * hop - last >= min_gap:
            lvl = max(env[i:i + 6]) - pk
            out.append((round(i * hop, 3), round(lvl, 1)))
            last = i * hop
    return out, len(a) / rate


def clean_hits(path, hop=0.005, max_len=0.35):
    """The single, clean hits inside a recording: [{t, start, len, level_db, clean, decay_ms}] and the duration.
    A hit is clean when it stands out of what is before it (7 dB over the 60 ms before), dies away (12 dB down
    within 120 ms of its peak) and is not followed by a second hit within 150 ms (a tumble, a double knock
    'tu-dum'). Recordings of a body falling or of blocks poured out hold two to nine hits, of which some are clean:
    those are the material for a bouncing ball, footsteps, knocks. `start` is 6 ms before the onset (an attack is
    not clipped), `len` the length up to the decay, the next hit or max_len."""
    a, rate = decode_sound(path, 16000)
    w = int(rate * hop)
    env = []
    for i in range(0, len(a) - w + 1, w):
        seg = a[i:i + w]
        e = math.sqrt(sum(v * v for v in seg) / w)
        env.append(20 * math.log10(e / 32768.0) if e > 0 else -100.0)
    n = len(env)
    dur = len(a) / rate if rate else 0.0
    if n < 6:
        return [], dur
    pk = max(env)
    cand = []
    for i in range(2, n):
        if env[i] > pk - 30.0 and env[i] - max(env[i - 2], env[i - 1]) >= 8.0 and                 (not cand or (i - cand[-1]) * hop >= 0.030):
            cand.append(i)
    out = []
    near = int(0.12 / hop)
    for k, i in enumerate(cand):
        limit = min(n, i + int(max_len / hop) + 1, cand[k + 1] if k + 1 < len(cand) else n)
        peak_i = max(range(i, min(n, i + 10)), key=lambda x: env[x])
        peak = env[peak_i]
        dec = next((x for x in range(peak_i + 1, limit) if env[x] <= peak - 20.0), None)
        end = dec if dec is not None else limit
        fell = any(env[x] <= peak - 12.0 for x in range(peak_i + 1, min(n, peak_i + near + 1)))
        rise, lo = False, peak
        for x in range(peak_i + 1, min(n, peak_i + int(0.15 / hop))):
            lo = min(lo, env[x])
            if env[x] - lo >= 6.0 and env[x] >= peak - 10.0:
                rise = True
                break
        pre = env[max(0, i - 12):i]
        stands_out = (not pre) or (max(pre) <= peak - 7.0)
        length = (end - i) * hop
        seg_ = a[i * w:i * w + int(min(max_len, max(0.04, length)) * rate)]
        zc = sum(1 for x_, y_ in zip(seg_, seg_[1:]) if (x_ < 0) != (y_ < 0))
        zcr = zc / 2.0 / max(0.02, len(seg_) / rate)          # about half the dominant frequency in Hz
        out.append({"t": round(i * hop, 3), "start": round(max(0.0, i * hop - 0.006), 3),
                    "len": round(min(max_len, max(0.04, length)), 3), "level_db": round(peak - pk, 1),
                    "zcr": int(zcr),
                    "clean": bool(stands_out and fell and not rise and length >= 0.04),
                    "decay_ms": int(round(1000 * (end - peak_i) * hop))})
    return out, dur


def centroid_window(path, t0, dur, rate=16000):
    """Spectral centroid (Hz) of a window of a file, as the energy-weighted MEDIAN of its 64 ms frames: the swell of a
    whoosh decides it, a click that happens inside the window does not. None when the window is silent."""
    p = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{max(0.0, t0):.3f}", "-t", f"{dur:.3f}",
                        "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"], capture_output=True)
    a = array.array("h")
    a.frombytes(p.stdout[: len(p.stdout) // 2 * 2])
    n = 1024
    frames = []
    for i in range(0, len(a) - n + 1, n // 2):
        seg = a[i:i + n]
        en = sum(v * v for v in seg)
        if en <= 0:
            continue
        re_ = [seg[k] * (0.5 - 0.5 * math.cos(2 * math.pi * k / (n - 1))) for k in range(n)]
        im_ = [0.0] * n
        _fft(re_, im_)
        mags = [math.hypot(re_[k], im_[k]) ** 2 for k in range(1, n // 2)]
        tot = sum(mags)
        if tot <= 0:
            continue
        cen = sum((k + 1) * rate / n * m for k, m in enumerate(mags)) / tot
        frames.append((en, cen))
    if not frames:
        return None
    top = max(e for e, _ in frames)
    live = sorted((c for e, c in frames if e >= 0.05 * top))
    return round(live[len(live) // 2], 0) if live else None


def onset_time(path, max_s=2.0):
    """Seconds until the sound AUDIBLY starts: the first 2 ms window within 20 dB of its own peak that rises at least
    6 dB over the two windows before (the definition verify.py judges a start-anchored sound by). A pop with 85 ms of
    near-silence in front, a breath before a mouth pop: that lead-in is not the sound and must not sit on the moment."""
    try:
        a, rate = decode_sound(path, 16000)
    except SystemExit:
        return 0.0
    n = min(len(a), int(max_s * rate))
    w = max(1, rate // 500)
    if n < 4 * w:
        return 0.0
    step = max(1, w // 2)
    env = [max(abs(v) for v in a[i:i + w]) for i in range(0, n - w, step)]
    db = [20 * math.log10(max(e, 1) / 32768.0) for e in env]
    if len(db) < 4:
        return 0.0
    top = max(db)
    for i in range(len(db)):
        if db[i] >= top - 20.0 and (i < 2 or db[i] - min(db[i - 1], db[i - 2]) >= 6.0):
            return round(i * step / rate, 4)
    return 0.0


# Round 9 (the sync test): where the MOMENT of a sound is. The loudest 20 ms (`peak_time`) is the moment of a sound that builds to a
# climax (a riser, a swell into a drop) and a bad one for a sound that is loud from the start (a hit with a long body, a bleep, a
# texture): its loudest window is somewhere inside it, so it sounded 0.15-3 s before the picture. Such a sound goes by its ARRIVAL.
ARRIVE_CLIMB_S = 0.45       # from the first level within 20 dB of the loudest to the first within 3 dB: longer = it builds to a climax
ARRIVE_MIN_GAP_S = 0.10     # the arrival has to be this much earlier than the peak for the shift to be worth making


def arrival_landmarks(path):
    """Where a sound ARRIVES, read on its level over 60 ms looking forward (one 20 ms click in front of a quiet sound is not an
    arrival): `peak` the loudest single 20 ms (analyse_sound's peak_time), `arrive` the first 60 ms within 6 dB of the loudest,
    `onset20` the first within 20 dB, `near` the first within 3 dB, `climb` = near - onset20. None when it cannot be decoded."""
    try:
        a, rate = decode_sound(path, 16000)
    except SystemExit:
        return None
    win = max(1, rate // 50)
    n = len(a) // win
    if n < 3:
        return None
    e = [sum(v * v for v in a[i * win:(i + 1) * win]) for i in range(n)]
    es = [(e[i] + (e[i + 1] if i + 1 < n else 0) + (e[i + 2] if i + 2 < n else 0)) / 3.0 for i in range(n)]
    top = max(es)
    if top <= 0:
        return None
    first = lambda db: next(i for i in range(n) if es[i] >= top * 10 ** (-db / 10.0))      # noqa: E731
    t = lambda i: round(i * win / rate + 0.01, 3)                                          # noqa: E731
    ip = max(range(n), key=e.__getitem__)
    out = {"peak": t(ip), "arrive": t(first(6.0)), "onset20": t(first(20.0)), "near": t(first(3.0))}
    out["climb"] = round(out["near"] - out["onset20"], 3)
    return out


def arrive_offset(arrival, peak_time, forced=False):
    """Seconds into the sound that go on the moment when the anchor is `arrive`, or None when the sound is better placed by its
    peak: a sound that takes ARRIVE_CLIMB_S or more to climb to near its loudest builds to a climax, and one whose arrival is
    less than ARRIVE_MIN_GAP_S before the peak gains nothing. `forced` (an explicit anchor "arrive") skips both tests."""
    if not arrival:
        return None
    if forced:
        return arrival["arrive"]
    if arrival["climb"] < ARRIVE_CLIMB_S and peak_time - arrival["arrive"] >= ARRIVE_MIN_GAP_S:
        return arrival["arrive"]
    return None


def analyse_sound(path):
    """Return duration, sample peak (dBFS), mean RMS (dBFS) and the time of the loudest 20 ms. A sound whose channels
    are in opposite phase is measured on its louder channel (`mono_ref` says which)."""
    a, rate = decode_sound(path)
    if not a:
        return None
    n = len(a)
    peak = max(max(a), -min(a)) or 1
    pk2, corr = stereo_peak(path)
    if pk2:
        peak = max(peak, pk2)
    mean_sq = sum(s * s for s in a) / n
    win = max(1, rate // 50)
    best, best_i = -1.0, 0
    for i in range(0, n - win + 1, win):
        e = sum(s * s for s in a[i:i + win])
        if e > best:
            best, best_i = e, i
    db = lambda v: round(20 * math.log10(v / 32768.0), 1) if v > 0 else -120.0
    out = {
        "duration": round(n / rate, 3),
        "peak_db": db(peak),
        "mean_db": db(math.sqrt(mean_sq)),
        "peak_time": round(best_i / rate + 0.01, 3),
    }
    nat = native_peak_db(path)
    if nat is not None:
        out["peak_db"] = max(out["peak_db"], nat)      # the real peak, not the 16 kHz mono view of it
    if corr is not None:
        out["lr_corr"] = round(corr, 2)
    if _INV.get(str(path)) is not None:
        out["mono_ref"] = _INV[str(path)]
    out.update(sound_features(a, rate) or {})
    return out


# ---------------------------------------------------------------- sound character ("features")
def _fft(re_, im_):
    """In-place iterative radix-2 FFT. len must be a power of two."""
    n = len(re_)
    j = 0
    for i in range(1, n):
        bit = n >> 1
        while j & bit:
            j ^= bit
            bit >>= 1
        j ^= bit
        if i < j:
            re_[i], re_[j] = re_[j], re_[i]
            im_[i], im_[j] = im_[j], im_[i]
    size = 2
    while size <= n:
        ang = -2 * math.pi / size
        wr, wi = math.cos(ang), math.sin(ang)
        for start in range(0, n, size):
            cr, ci = 1.0, 0.0
            half = size // 2
            for k in range(half):
                a, b = start + k, start + k + half
                tr = re_[b] * cr - im_[b] * ci
                ti = re_[b] * ci + im_[b] * cr
                re_[b], im_[b] = re_[a] - tr, im_[a] - ti
                re_[a], im_[a] = re_[a] + tr, im_[a] + ti
                cr, ci = cr * wr - ci * wi, cr * wi + ci * wr
        size <<= 1


def sound_features(samples, rate=16000):
    """Measurable character of a sound: how it starts, how long it rings, where its energy sits.

    attack_ms   time from the first audible energy to the loudest 10 ms (small = punchy)
    decay_ms    time from the loudest point until 30 dB below it (long = tail/ring)
    centroid    energy-weighted mean frequency in Hz (high = bright, low = dark/heavy)
    rolloff     frequency under which 85 % of the energy sits
    low / high  share of energy below 250 Hz / above 4 kHz
    flat        0..1, 1 = noise-like (whoosh, air), 0 = tonal (bell, sub)
    active_dur  seconds until the content falls 40 dB under its peak (the rest is silence or room tail)
    """
    n = len(samples)
    w10 = rate // 100
    env = [math.sqrt(sum(v * v for v in samples[i:i + w10]) / w10) for i in range(0, n - w10 + 1, w10)]
    if not env or max(env) <= 0:
        return None
    pk = max(env)
    pk_i = env.index(pk)
    ai = next((i for i, e in enumerate(env) if e >= 0.1 * pk), 0)
    di = next((i for i in range(pk_i + 1, len(env)) if env[i] <= pk * 0.0316), len(env))
    # pulsing: how many separate swells the envelope has per second of active sound (a smooth whoosh has ~1,
    # a tremolo / rhythmic pattern has many)
    sm = [sum(env[max(0, i - 2):i + 3]) / len(env[max(0, i - 2):i + 3]) for i in range(len(env))]
    bumps = 0
    for i in range(2, len(sm) - 2):
        if sm[i] >= 0.25 * pk and sm[i] == max(sm[i - 2:i + 3]) and                 sm[i] - min(sm[max(0, i - 15):i + 16]) >= 0.2 * pk:
            bumps += 1
    active_s = max(0.3, sum(1 for e in env if e >= 0.1 * pk) * 0.01)
    # where the content ends: last 10 ms above -40 dB under the peak. Pack files padded to a fixed length
    # (1.07 / 2.09 / 3.06 s) carry seconds of silence after a 0.3 s click; length decisions must not count it
    last = max((i for i, e in enumerate(env) if e >= pk * 0.01), default=0)
    active_dur = round(min(n / rate, (last + 1) * 0.01 + 0.02), 2)
    N = 1024
    hann = [0.5 - 0.5 * math.cos(2 * math.pi * i / (N - 1)) for i in range(N)]
    # up to 10 analysis windows placed where there is real energy, within the first 4 s
    limit = min(n, rate * 4)
    # a window counts when its mean power is above (10 % of the peak envelope)^2
    thr = (0.1 * pk) ** 2
    starts = [s for s in range(0, max(1, limit - N), N // 2)
              if sum(v * v for v in samples[s:s + N:4]) / len(samples[s:s + N:4]) > thr]
    if not starts:
        starts = [0]
    if len(starts) > 10:
        step = len(starts) / 10
        starts = [starts[int(i * step)] for i in range(10)]
    bins = N // 2
    power = [0.0] * bins
    for s in starts:
        seg = samples[s:s + N]
        if len(seg) < N:
            seg = list(seg) + [0] * (N - len(seg))
        re_ = [seg[i] * hann[i] for i in range(N)]
        im_ = [0.0] * N
        _fft(re_, im_)
        for k in range(bins):
            power[k] += re_[k] * re_[k] + im_[k] * im_[k]
    tot = sum(power) or 1.0
    hz = rate / N
    centroid = sum(k * hz * p for k, p in enumerate(power)) / tot
    acc, roll = 0.0, 0.0
    for k, p in enumerate(power):
        acc += p
        if acc >= 0.85 * tot:
            roll = k * hz
            break
    low = sum(p for k, p in enumerate(power) if k * hz < 250) / tot
    high = sum(p for k, p in enumerate(power) if k * hz > 4000) / tot
    band = [p + 1e-9 for k, p in enumerate(power) if 100 <= k * hz <= 7000]
    flat = math.exp(sum(math.log(p) for p in band) / len(band)) / (sum(band) / len(band)) if band else 0.0
    return {
        "attack_ms": int((pk_i - ai) * 10),
        "decay_ms": int((di - pk_i) * 10),
        "centroid": int(centroid),
        "rolloff": int(roll),
        "low": round(low, 3),
        "high": round(high, 3),
        "flat": round(min(1.0, flat), 3),
        "bumps": round(bumps / active_s, 1),
        "active_dur": active_dur,
    }


def avg_power(samples, n=1024, max_windows=10):
    """Mean power spectrum of a segment (list of n/2 bins), or None if it is too short."""
    if len(samples) < n:
        return None
    hann = [0.5 - 0.5 * math.cos(2 * math.pi * i / (n - 1)) for i in range(n)]
    hop = max(n // 2, (len(samples) - n) // max(1, max_windows - 1))
    starts = list(range(0, len(samples) - n + 1, hop))[:max_windows]
    bins = n // 2
    acc = [0.0] * bins
    for st in starts:
        re_ = [samples[st + i] * hann[i] for i in range(n)]
        im_ = [0.0] * n
        _fft(re_, im_)
        for k in range(bins):
            acc[k] += re_[k] * re_[k] + im_[k] * im_[k]
    return [v / len(starts) for v in acc]


def character_from_power(power, rate=16000, n=1024):
    """centroid/rolloff/low/high/flat from a power spectrum (see sound_features for the meaning)."""
    tot = sum(power) or 1.0
    hz = rate / n
    centroid = sum(k * hz * p for k, p in enumerate(power)) / tot
    acc, roll = 0.0, 0.0
    for k, p in enumerate(power):
        acc += p
        if acc >= 0.85 * tot:
            roll = k * hz
            break
    low = sum(p for k, p in enumerate(power) if k * hz < 250) / tot
    high = sum(p for k, p in enumerate(power) if k * hz > 4000) / tot
    band = [p + 1e-9 for k, p in enumerate(power) if 100 <= k * hz <= 7000]
    flat = math.exp(sum(math.log(p) for p in band) / len(band)) / (sum(band) / len(band)) if band else 0.0
    return {"centroid": int(centroid), "rolloff": int(roll), "low": round(low, 3), "high": round(high, 3),
            "flat": round(min(1.0, flat), 3)}


def effective_dur(rec):
    """Length of the audible content: the file length, minus a silent tail when the file is padded."""
    d = rec.get("duration", 0.0) or 0.0
    a = rec.get("active_dur")
    return min(d, a) if a else d


_FAM_DROP = re.compile(r"\[[^\]]*\]|\([^)]*\)|\.(wav|mp3|flac|aiff?|ogg)\b|\b(copy|new|alt|v\d+)\b|\d+", re.I)


def family_key(name):
    """'Glass Crack - 03' and 'Glass Crack - 01' are one family of takes; 'Hit 1' and 'Hit 2' too.
    Used so that a sheet does not get four takes of the same recording and call them variety."""
    t = _FAM_DROP.sub(" ", str(name).replace("_", " "))
    t = re.sub(r"[^\w]+", " ", t, flags=re.U).strip().lower()
    return t or str(name).lower()


def window_levels(path, ms=250, rate=16000):
    """RMS level (dBFS, -100 for silence) of consecutive `ms` windows of an audio file's mono sum. Pure python."""
    import array
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(rate),
                        "-f", "s16le", "-"], capture_output=True)
    x = array.array("h")
    x.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    w = max(1, rate * ms // 1000)
    out = []
    for i in range(0, len(x) - w + 1, w):
        e = math.sqrt(sum(v * v for v in x[i:i + w]) / w) / 32768.0
        out.append(20 * math.log10(e) if e > 1e-5 else -100.0)
    return out


# personal cache {path: steadiness}, never packaged (REAL_SFX_STEADY names another file: the selftest)
STEADY_PATH = Path(os.environ.get("REAL_SFX_STEADY") or SKILL_DIR / "ambience_steady.json")


def steadiness(path, max_s=30.0, rate=16000):
    """How STEADY a recording's level is (dB, pure python), the number a bed is judged by:
      ripple   median over 1 s stretches of the spread P90-P10 of the 50 ms levels: how much the level moves at the
               speed of a pulse. A sub drone that throbs about twice a second has 5-8 dB, a steady room 2-3, hiss 1;
      flutter  mean change between neighbouring 50 ms levels (the same, without the stretches);
      swing    P95-P5 of the 250 ms levels: slow drift, fades, a gap (a recording with silence has 30+).
    The first `max_s` seconds are measured. None when it is shorter than 3 s."""
    import array
    r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-t", f"{max_s:g}", "-i", str(path), "-vn", "-ac", "1",
                        "-ar", str(rate), "-f", "s16le", "-"], capture_output=True)
    x = array.array("h")
    x.frombytes(r.stdout[: len(r.stdout) // 2 * 2])
    w = rate // 20
    if len(x) < 3 * rate:
        return None
    pw = [sum(v * v for v in x[i:i + w]) / w / (32768.0 ** 2) for i in range(0, len(x) - w + 1, w)]
    l50 = [10 * math.log10(p) if p > 1e-10 else -100.0 for p in pw]
    srt = lambda v, q: sorted(v)[min(len(v) - 1, int(q * (len(v) - 1) + 0.5))]
    spreads = [srt(l50[i:i + 20], 0.9) - srt(l50[i:i + 20], 0.1) for i in range(0, len(l50) - 19, 10)]
    l250 = [10 * math.log10(max(1e-10, sum(pw[i:i + 5]) / 5)) for i in range(0, len(pw) - 4, 5)]
    if not spreads or len(l250) < 6:
        return None
    return {"ripple": round(srt(spreads, 0.5), 1),
            "flutter": round(sum(abs(b - a) for a, b in zip(l50, l50[1:])) / max(1, len(l50) - 1), 2),
            "swing": round(srt(l250, 0.95) - srt(l250, 0.05), 1)}


def steady_of(rec, cache, max_s=30.0):
    """`steadiness` of an index record through the cache (a dict the caller keeps and saves with save_steady):
    measured once per file and size."""
    p = rec["path"]
    try:
        size = os.path.getsize(p)
    except OSError:
        return None
    c = cache.get(p)
    if c and c.get("size") == size:
        return c
    st = steadiness(p, max_s)
    if st is None:
        return None
    st["size"] = size
    cache[p] = st
    return st


def load_steady():
    try:
        return json.loads(STEADY_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_steady(cache):
    tmp = STEADY_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    tmp.replace(STEADY_PATH)


GESTURE_GAP = 0.25            # seconds: sounds closer than this are one gesture (refstyle.py uses the same on audio)


def gesture_times(cues, gap=GESTURE_GAP, skip_roles=("ambience", "vehicle")):
    """The ONE definition of how busy a film is: the times (sorted) of its gestures, a gesture being a run of sounds
    with no pause of `gap` seconds in it. `cues` are cue dicts of a source sheet (their `layers` count, at t + dt) or
    of a resolved sheet (layers are cues of their own). Long beds (ambience, vehicle) are not gestures. The same
    definition is applied to the SOUND of a film by refstyle.py, so the critique's pace, texture.py's target and the
    table against the reference style speak of one number: gestures per 10 s."""
    ts = []
    for c in cues:
        role = c.get("role") or (c.get("pick") or {}).get("role")
        if "t" not in c or role in skip_roles:
            continue
        ts.append(float(c["t"]))
        for lay in c.get("layers") or []:
            lrole = lay.get("role") or (lay.get("pick") or {}).get("role")
            if lrole not in skip_roles:
                ts.append(float(c["t"]) + float(lay.get("dt", 0.0)))
    ts.sort()
    out = []
    for t in ts:
        if not out or t - last > gap:
            out.append(t)
        last = t
    return out


def words(f):
    """Plain words for how a sound sounds, from its measured character. Searchable with search.py --says.

    This is the nearest thing to hearing that needs no model: attack, brightness, weight, tail, noisiness.
    """
    if not f or "centroid" not in f:
        return []
    w = []
    a, d, c, lo, fl = f["attack_ms"], f["decay_ms"], f["centroid"], f["low"], f["flat"]
    w.append("punchy" if a <= 30 else "soft-attack" if a <= 120 else "swelling" if a <= 400 else "slow-build")
    w.append("sub" if c < 150 else "dark" if c < 600 else "warm" if c < 1500 else "mid" if c < 3000 else "bright"
             if c < 5000 else "airy")
    if lo >= 0.7:
        w.append("heavy")
    elif lo <= 0.05:
        w.append("thin")
    w.append("noisy" if fl >= 0.5 else "tonal" if fl <= 0.12 else "textured")
    dur = effective_dur(f)
    w.append("tiny" if dur < 0.15 else "short" if dur < 0.6 else "medium" if dur < 1.6 else "long" if dur < 5 else "bed")
    if f.get("bumps", 0) >= 8 and dur >= 0.5:
        w.append("pulsing")
    if d >= 700 and dur >= 0.6:
        w.append("long-tail")
    elif d <= 120 and dur < 1.0:
        w.append("dry")
    return w
