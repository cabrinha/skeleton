import os
import re
import time
import pickle
import tempfile
import threading
import urllib.parse
from pathlib import Path
from dotenv import load_dotenv

import requests
from bs4 import BeautifulSoup
from PIL import Image
import pytesseract
from prometheus_client import start_http_server, Counter, Gauge

load_dotenv()

BASE_URL   = "https://quiz.ravenblack.net/blood.pl"
COOKIE_FILE = Path(os.environ.get("COOKIE_FILE", ".cookies"))
A_TO_Z     = "abcdefghijklmnopqrstuvwxyz"
AP_PER_TICK = 15 * 60   # seconds per 1 AP
MAX_AP      = 90
METRICS_PORT = int(os.environ.get("METRICS_PORT", "8080"))

DIRECTIONS = [
    "north", "south", "east", "west",
    "northwest", "northeast", "southwest", "southeast",
]

# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------

_m_pints             = Counter("skeleton_pints_total",            "Pints of blood consumed")
_m_humans_bitten     = Counter("skeleton_humans_bitten_total",    "Humans bitten")
_m_hunters_enc       = Counter("skeleton_hunters_encountered_total", "Hunter NPCs encountered")
_m_hunters_killed    = Counter("skeleton_hunters_killed_total",   "Hunter NPCs killed")
_m_moves             = Counter("skeleton_moves_total",            "Map moves made")

_m_pos_x             = Gauge("skeleton_position_x",              "Current X coordinate (1–100)")
_m_pos_y             = Gauge("skeleton_position_y",              "Current Y coordinate (1–100)")
_m_ap                = Gauge("skeleton_ap_current",              "Current action points")
_m_ap_max            = Gauge("skeleton_ap_max",                  "Maximum action points")
_m_ap_eta            = Gauge("skeleton_ap_seconds_until_full",   "Estimated seconds until AP is full")
_m_hunting           = Gauge("skeleton_hunt_active",             "1 while hunting, 0 while waiting")
_m_session_pints     = Gauge("skeleton_session_pints",           "Pints consumed this hunt session")
_m_session_humans    = Gauge("skeleton_session_humans_bitten",   "Humans bitten this hunt session")


def start_metrics_server():
    start_http_server(METRICS_PORT)
    print(f"[metrics] Listening on :{METRICS_PORT}")


# ---------------------------------------------------------------------------
# Anti-robot solver
# ---------------------------------------------------------------------------

def _decode_antibot_image(colors: list[str], pixel_str: str) -> Image.Image:
    cols = 4 * 4 * 6  # 96 cells wide
    cell_w, cell_h = 2, 4
    rows = len(pixel_str) // cols
    img = Image.new("RGB", (cols * cell_w, rows * cell_h))
    pixels = img.load()
    for i, ch in enumerate(pixel_str):
        hx = colors[A_TO_Z.index(ch)]
        rgb = (int(hx[0:2], 16), int(hx[2:4], 16), int(hx[4:6], 16))
        col, row = i % cols, i // cols
        for dy in range(cell_h):
            for dx in range(cell_w):
                pixels[col * cell_w + dx, row * cell_h + dy] = rgb
    return img


def _ocr_number(img: Image.Image) -> str | None:
    import numpy as np
    from PIL import ImageFilter
    gray = img.convert("L")
    arr  = np.array(gray)
    bw   = Image.fromarray((arr < 80).astype("uint8") * 255)
    bw   = bw.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    scale = 12
    big  = bw.resize((bw.width * scale, bw.height * scale), Image.NEAREST)
    padded = Image.new("L", (big.width + 80, big.height + 80), 255)
    padded.paste(big, (40, 40))
    result = pytesseract.image_to_string(
        padded, config="--oem 1 --psm 7 -c tessedit_char_whitelist=0123456789"
    ).strip()
    return result if result.isdigit() else None


def solve_antibot(page_html: str) -> tuple[str, str] | None:
    m = re.search(
        r"anti_robot\(Array\(([^)]+)\)\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)",
        page_html,
    )
    if not m:
        return None
    raw_colors = re.findall(r'"([0-9a-f]{6})"', m.group(1))
    pixel_str  = m.group(2)
    field_name = m.group(3)
    img    = _decode_antibot_image(raw_colors, pixel_str)
    answer = _ocr_number(img)
    if answer:
        print(f"[~] Anti-bot solved automatically: {answer}")
        return field_name, answer
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    img.save(tmp.name)
    print(f"[!] Could not auto-solve anti-bot. Image saved to: {tmp.name}")
    answer = input("    Enter the number shown in the image: ").strip()
    return field_name, answer


# ---------------------------------------------------------------------------
# Skeleton — session + game actions
# ---------------------------------------------------------------------------

class Skeleton:
    def __init__(self, name: str, password: str):
        self.name     = name
        self.password = password
        self.session  = requests.Session()
        self.session.headers.update({"User-Agent": "skeleton-bot/1.0"})
        self._last_page: BeautifulSoup | None = None

    # --- Cookie management ---

    def save_cookies(self):
        COOKIE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(COOKIE_FILE, "wb") as f:
            pickle.dump(self.session.cookies, f)

    def load_cookies(self) -> bool:
        if COOKIE_FILE.exists():
            with open(COOKIE_FILE, "rb") as f:
                self.session.cookies.update(pickle.load(f))
            return True
        return False

    def inject_env_cookies(self) -> bool:
        """Use VAMPIRE_COOKIE_PQ / VAMPIRE_COOKIE_IP env vars (K8s/Docker path)."""
        pq = os.environ.get("VAMPIRE_COOKIE_PQ")
        ip = os.environ.get("VAMPIRE_COOKIE_IP")
        if pq and ip:
            self.session.cookies.set("pq", pq, domain="quiz.ravenblack.net")
            self.session.cookies.set("ip", ip, domain="quiz.ravenblack.net")
            return True
        return False

    def import_browser_cookies(self) -> bool:
        """Pull live cookies from Arc — only works in local dev."""
        try:
            import browser_cookie3
            cj = browser_cookie3.arc(domain_name="quiz.ravenblack.net")
            cookies = list(cj)
            if not cookies:
                return False
            for c in cookies:
                self.session.cookies.set(c.name, c.value, domain=c.domain)
            self.save_cookies()
            print(f"[+] Imported {len(cookies)} cookie(s) from Arc")
            return True
        except Exception:
            return False

    # --- HTTP core ---

    def _handle_antibot(self, html: str) -> str | None:
        result = solve_antibot(html)
        if result is None:
            return None
        field_name, answer = result
        resp = self.session.post(BASE_URL, data={"action": "robot", field_name: answer})
        resp.raise_for_status()
        self.save_cookies()
        return resp.text

    def _post(self, **fields) -> BeautifulSoup:
        resp = self.session.post(BASE_URL, data=fields)
        resp.raise_for_status()
        html = resp.text
        if "anti_robot" in html:
            html = self._handle_antibot(html) or html
        self._last_page = BeautifulSoup(html, "html.parser")
        return self._last_page

    def _get(self) -> BeautifulSoup:
        resp = self.session.get(BASE_URL)
        resp.raise_for_status()
        html = resp.text
        if "anti_robot" in html:
            html = self._handle_antibot(html) or html
        self._last_page = BeautifulSoup(html, "html.parser")
        return self._last_page

    def _extract_z(self) -> str | None:
        """Extract the session z-token from links on the current page."""
        if self._last_page is None:
            return None
        for a in self._last_page.find_all("a", href=True):
            m = re.search(r"[?&]z=(\d+)", a["href"])
            if m:
                return m.group(1)
        return None

    def drink_from(self, name: str, method: str, request_params: dict) -> BeautifulSoup:
        """Drink from target. Vampires: GET+z-token; Humans: POST with t= field."""
        if method == "post":
            return self._post(**request_params)
        get_params = {"action": "drink", **request_params}
        z = self._extract_z()
        if z:
            get_params["z"] = z
        resp = self.session.get(BASE_URL, params=get_params)
        resp.raise_for_status()
        html = resp.text
        if "anti_robot" in html:
            html = self._handle_antibot(html) or html
        self._last_page = BeautifulSoup(html, "html.parser")
        return self._last_page

    # --- Auth ---

    def login(self) -> bool:
        # 1. K8s/Docker: env-injected cookies
        if self.inject_env_cookies():
            self._get()
            if self._is_logged_in():
                print(f"[+] Session active as {self.name} (env cookies)")
                return True

        # 2. Local dev: live Arc browser cookies
        if self.import_browser_cookies():
            self._get()
            if self._is_logged_in():
                print(f"[+] Session active as {self.name} (Arc browser)")
                return True

        # 3. Saved cookie file
        if self.load_cookies():
            self._get()
            if self._is_logged_in():
                print(f"[+] Resumed session as {self.name} (cookie file)")
                return True

        # 4. Full login
        self._post(action="login", iam=self.name, passwd=self.password)
        if self._is_logged_in():
            self.save_cookies()
            print(f"[+] Logged in as {self.name}")
            return True

        print("[-] Login failed")
        return False

    def _is_logged_in(self) -> bool:
        if self._last_page is None:
            return False
        return self._last_page.find("input", {"name": "passwd"}) is None

    # --- Page parsing ---

    def parse_ap(self) -> tuple[int, int] | None:
        if self._last_page is None:
            return None
        for text in self._last_page.stripped_strings:
            m = re.match(r"Action Points:\s*(\d+)/(\d+)", text)
            if m:
                return int(m.group(1)), int(m.group(2))
        return None

    def parse_position(self) -> tuple[int, int] | None:
        if self._last_page is None:
            return None
        xs_inp = self._last_page.find_all("input", {"name": "x"})
        ys_inp = self._last_page.find_all("input", {"name": "y"})
        if not xs_inp:
            return None
        xs = sorted({int(f["value"]) for f in xs_inp})
        ys = sorted({int(f["value"]) for f in ys_inp})
        if len(xs) >= 2 and len(ys) >= 2:
            return xs[len(xs) // 2], ys[len(ys) // 2]
        return None

    def status(self) -> dict:
        ap  = self.parse_ap()
        pos = self.parse_position()
        return {
            "position": pos,
            "ap":       ap[0] if ap else None,
            "max_ap":   ap[1] if ap else None,
        }

    # --- Game actions ---

    def move_to(self, x: int, y: int) -> BeautifulSoup:
        page = self._post(action="move", x=x, y=y)
        _m_moves.inc()
        pos = self.parse_position()
        if pos:
            _m_pos_x.set(pos[0])
            _m_pos_y.set(pos[1])
        ap = self.parse_ap()
        if ap:
            _m_ap.set(ap[0])
            _m_ap_max.set(ap[1])
            _m_ap_eta.set(max(0, (ap[1] - ap[0]) * AP_PER_TICK))
        return page

    def move(self, direction: str) -> BeautifulSoup:
        assert direction in DIRECTIONS, f"Unknown direction: {direction}"
        pos = self.parse_position()
        if pos is None:
            raise RuntimeError("Cannot determine current position")
        dx = {"east": 1, "west": -1, "northeast": 1, "northwest": -1,
              "southeast": 1, "southwest": -1}.get(direction, 0)
        dy = {"south": 1, "north": -1, "southeast": 1, "southwest": 1,
              "northeast": -1, "northwest": -1}.get(direction, 0)
        return self.move_to(pos[0] + dx, pos[1] + dy)


# ---------------------------------------------------------------------------
# Grid parser
# ---------------------------------------------------------------------------

def parse_grid(page: BeautifulSoup) -> dict:
    """
    Parse the 3x3 visible map. Returns dict keyed by (x, y):
      is_current    bool
      class         'street' | 'intersect' | 'city'
      name          intersection label or None
      vampires      [str]  — bold-named entities
      humans        [str]  — plain-named entities (mortals)
      drink_targets [str]  — names you can drink from (current cell)
      hunters       [str]  — names with a fight/attack form
    """
    cells = {}
    ap_text = page.find(string=re.compile(r"Action Points:"))
    if ap_text is None:
        return cells
    table = ap_text.find_parent("div").find("table")
    if table is None:
        return cells

    all_xs = [int(f["value"]) for f in page.find_all("input", {"name": "x"})]
    all_ys = [int(f["value"]) for f in page.find_all("input", {"name": "y"})]
    if not all_xs:
        return cells
    cx = sorted(set(all_xs))[len(set(all_xs)) // 2]
    cy = sorted(set(all_ys))[len(set(all_ys)) // 2]

    for td in table.find_all("td"):
        xi = td.find("input", {"name": "x"})
        if xi:
            x, y = int(xi["value"]), int(td.find("input", {"name": "y"})["value"])
            is_current = False
        else:
            x, y = cx, cy
            is_current = True

        span = td.find("span", class_="intersect")
        cell_name = span.get_text(strip=True) if span else None

        # Self: bold tags (own vampire name in current cell)
        # Other vampires: <a> links with viewvamp in href
        vampires = [b.get_text(strip=True) for b in td.find_all("b") if b.get_text(strip=True)]
        for a in td.find_all("a", href=True):
            if "viewvamp" in a["href"]:
                vname = a.get_text(strip=True)
                if vname and vname not in vampires:
                    vampires.append(vname)

        # Drink targets: (display_name, method, request_params)
        # Vampires: GET link with target=Name; Humans: POST form with t=0|0
        drink_targets: list[tuple[str, str, dict]] = []
        seen_drink: set[str] = set()
        for a in td.find_all("a", href=True):
            if "action=drink" in a["href"]:
                m = re.search(r"target=([^&\s]+)", a["href"])
                if m:
                    name = urllib.parse.unquote_plus(m.group(1))
                    if name not in seen_drink:
                        drink_targets.append((name, "get", {"target": name}))
                        seen_drink.add(name)
        for form in td.find_all("form"):
            action_inp = form.find("input", {"name": "action"})
            if not (action_inp and action_inp.get("value") == "drink"):
                continue
            target_inp = form.find("input", {"name": "target"})
            t_inp      = form.find("input", {"name": "t"})
            if target_inp:
                name = target_inp["value"]
                post_data = {"action": "drink", "target": name}
            elif t_inp:
                name = f"Human({t_inp['value']})"
                post_data = {"action": "drink", "t": t_inp["value"]}
            else:
                continue
            if name not in seen_drink:
                drink_targets.append((name, "post", post_data))
                seen_drink.add(name)

        # Hunters: fight/attack/kill links or forms
        hunters: list[str] = []
        for a in td.find_all("a", href=True):
            if any(f"action={v}" in a["href"] for v in ("fight", "attack", "kill")):
                m = re.search(r"target=([^&\s]+)", a["href"])
                if m:
                    hname = urllib.parse.unquote_plus(m.group(1))
                    if hname not in hunters:
                        hunters.append(hname)
        for form in td.find_all("form"):
            action_inp = form.find("input", {"name": "action"})
            if action_inp and action_inp.get("value") in ("fight", "attack", "kill"):
                target_inp = form.find("input", {"name": "target"})
                if target_inp and target_inp["value"] not in hunters:
                    hunters.append(target_inp["value"])

        # Humans: plain-text names not associated with any link/tag
        # Exclude <a> tags (vampires use those); strip BP counts like "(408)"
        humans: list[str] = []
        for node in td.children:
            if getattr(node, "name", None) in ("b", "span", "form", "br", "a"):
                continue
            text = (node.get_text(strip=True) if hasattr(node, "get_text")
                    else str(node).strip())
            text = re.sub(r"\(\d+\)", "", text).strip("() ")
            if text and text not in ("Move Here", cell_name or "", "drink", "rob"):
                humans.append(text)

        cells[(x, y)] = {
            "is_current":    is_current,
            "class":         (td.get("class") or ["unknown"])[0],
            "name":          cell_name,
            "vampires":      vampires,
            "humans":        humans,
            "drink_targets": drink_targets,
            "hunters":       hunters,
        }

    return cells


# ---------------------------------------------------------------------------
# Hunter — the main loop
# ---------------------------------------------------------------------------

class Hunter:
    """
    Serpentine-sweeps the city looking for humans to bite.
    Emits Prometheus metrics throughout.
    """

    def __init__(self, bot: Skeleton, sweep_width: int = 20):
        self.bot          = bot
        self.sweep_width  = sweep_width
        self._direction   = -1                  # -1 = NE (y decreasing), +1 = SE (y increasing)
        self._drained: dict[tuple, set] = {}    # pos → set of targets drained there

    def _log(self, msg: str):
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    # --- AP management ---

    def wait_for_full_ap(self):
        _m_hunting.set(0)
        while True:
            self.bot._get()
            s = self.bot.status()
            ap, max_ap = s.get("ap"), s.get("max_ap") or MAX_AP
            if ap is None:
                self._log("Cannot read AP — retrying in 60s")
                time.sleep(60)
                continue
            _m_ap.set(ap)
            _m_ap_max.set(max_ap)
            if ap >= max_ap:
                _m_ap_eta.set(0)
                self._log(f"AP full ({ap}/{max_ap})")
                return
            needed     = max_ap - ap
            wait_secs  = needed * AP_PER_TICK
            wake_str   = time.strftime("%H:%M", time.localtime(time.time() + wait_secs))
            self._log(f"AP {ap}/{max_ap} — sleeping {needed * 15}m (until ~{wake_str})")
            self._sleep_updating_metrics(wait_secs, ap, max_ap)

    def _sleep_updating_metrics(self, total_secs: float, ap_start: int, max_ap: int):
        """Sleep total_secs, updating AP metrics every 60s."""
        started = time.time()
        while True:
            elapsed = time.time() - started
            if elapsed >= total_secs:
                break
            gained  = elapsed / AP_PER_TICK
            current = min(max_ap, ap_start + gained)
            _m_ap.set(current)
            _m_ap_eta.set(max(0, (max_ap - current) * AP_PER_TICK))
            time.sleep(min(60, total_secs - elapsed))

    # --- Drink logic ---

    def _drink_all(self, grid: dict, pos: tuple[int, int]):
        already_drained = self._drained.setdefault(pos, set())
        targets = [(n, m, p) for n, m, p in grid.get(pos, {}).get("drink_targets", [])
                   if n not in already_drained]
        for name, method, params in targets:
            self._log(f"Drinking from {name!r} ({method})")
            page  = self.bot.drink_from(name, method, params)
            pints = self._parse_pints(page)
            already_drained.add(name)
            if pints == 0:
                self._log(f"  → already drained (skipping)")
                continue
            self._log(f"  → got {pints} pint(s)")
            _m_pints.inc(pints)
            _m_humans_bitten.inc()
            _m_session_pints.inc(pints)
            _m_session_humans.inc()
            ap = self.bot.parse_ap()
            if ap:
                _m_ap.set(ap[0])
                _m_ap_eta.set(max(0, (ap[1] - ap[0]) * AP_PER_TICK))
            # Check for hunter text in the response
            if self._detect_hunter(page):
                _m_hunters_enc.inc()
                killed = self._fight_hunters(page)
                _m_hunters_killed.inc(killed)
            time.sleep(1)

    @staticmethod
    def _parse_pints(page: BeautifulSoup) -> int:
        for text in page.stripped_strings:
            lower = text.lower()
            if "have drunk" in lower:
                continue
            m = re.search(r"(\d+)\s+pint", lower)
            if m:
                return int(m.group(1))
        return 0

    @staticmethod
    def _detect_hunter(page: BeautifulSoup) -> bool:
        return any("hunter" in t.lower() for t in page.stripped_strings)

    def _fight_hunters(self, page: BeautifulSoup) -> int:
        """Fight back against any hunters on the page. Returns number killed."""
        killed = 0
        for form in page.find_all("form"):
            action = form.find("input", {"name": "action"})
            if action and action.get("value") in ("fight", "attack", "kill"):
                target = form.find("input", {"name": "target"})
                if target:
                    self._log(f"Fighting hunter {target['value']!r}")
                    result = self.bot._post(action=action["value"], target=target["value"])
                    if any("killed" in t.lower() or "destroyed" in t.lower()
                           for t in result.stripped_strings):
                        killed += 1
        return killed

    # --- Movement strategy ---

    def _next_sweep_pos(self, pos: tuple[int, int]) -> tuple[int, int]:
        """Diagonal NE/SE sweep across 200x200 map. _direction: -1=NE, +1=SE."""
        cx, cy = pos
        nx = cx + 1 if cx < 200 else 1   # wrap east edge back to west
        ny = cy + self._direction
        if ny < 1:
            self._direction = 1           # hit north edge, switch to SE
            ny = cy + 1
        elif ny > 200:
            self._direction = -1          # hit south edge, switch to NE
            ny = cy - 1
        return nx, ny

    # --- Main tick ---

    def tick(self, page: BeautifulSoup, ap: int, pos: tuple[int, int]) -> bool:
        grid = parse_grid(page)

        # 1. Drink from current cell — only if there are non-drained targets
        current = grid.get(pos, {})
        self._log(f"  cell drink_targets={current.get('drink_targets')}  vampires={current.get('vampires')}  humans={current.get('humans')}")
        available = [n for n, _, _ in current.get("drink_targets", [])
                     if n not in self._drained.get(pos, set())]
        if available:
            self._drink_all(grid, pos)
            return True

        # 2. Fight hunters in current cell
        if current.get("hunters"):
            _m_hunters_enc.inc(len(current["hunters"]))
            for hunter in current["hunters"]:
                result = self.bot._post(action="fight", target=hunter)
                if any("killed" in t.lower() for t in result.stripped_strings):
                    _m_hunters_killed.inc()

        # 3. Move toward adjacent cell with a drinkable entity (not already drained)
        for (nx, ny), cell in grid.items():
            if (nx, ny) == pos:
                continue
            drained_there = self._drained.get((nx, ny), set())
            others  = [v for v in cell.get("vampires", [])
                       if v != self.bot.name and v not in drained_there]
            humans  = [h for h in cell.get("humans", []) if h not in drained_there]
            targets = [n for n, _, _ in cell.get("drink_targets", []) if n not in drained_there]
            if others or humans or targets:
                self._log(f"Entity spotted at ({nx},{ny}) {others or humans} — moving there")
                self.bot.move_to(nx, ny)
                return True

        # 4. No humans visible — sweep
        nx, ny = self._next_sweep_pos(pos)
        self._log(f"Sweeping → ({nx},{ny})  AP={ap}")
        self.bot.move_to(nx, ny)
        return True

    # --- Run loop ---

    def run(self, wait_for_full: bool = True, single_run: bool = False,
            delay: float = 3.0):
        """
        Main hunt loop.

        wait_for_full  – block until AP=max before hunting.
        single_run     – exit after one AP cycle is exhausted (K8s CronJob mode).
        delay          – minimum seconds between actions.
        """
        delay = max(delay, 3.0)

        if wait_for_full:
            self.wait_for_full_ap()

        _m_session_pints.set(0)
        _m_session_humans.set(0)
        _m_hunting.set(1)
        self._log("Hunt started")

        while True:
            page = self.bot._get()

            if not self.bot._is_logged_in():
                self._log("Session expired — re-authenticating")
                if not self.bot.login():
                    self._log("Re-login failed, stopping")
                    return
                continue

            s   = self.bot.status()
            ap  = s.get("ap")
            pos = s.get("position")

            if ap is None or pos is None:
                self._log("Could not read game state — stopping to be safe")
                return

            _m_ap.set(ap)
            if s.get("max_ap"):
                _m_ap_max.set(s["max_ap"])
                _m_ap_eta.set(max(0, (s["max_ap"] - ap) * AP_PER_TICK))
            _m_pos_x.set(pos[0])
            _m_pos_y.set(pos[1])

            if ap <= 0:
                _m_hunting.set(0)
                if single_run:
                    self._log("AP exhausted — hunt complete (single-run mode)")
                    return
                max_ap     = s.get("max_ap") or MAX_AP
                wait_secs  = max_ap * AP_PER_TICK
                wake_str   = time.strftime("%H:%M", time.localtime(time.time() + wait_secs))
                self._log(f"AP exhausted — sleeping until full (~{wake_str})")
                self._sleep_updating_metrics(wait_secs, 0, max_ap)
                _m_hunting.set(1)
                _m_session_pints.set(0)
                _m_session_humans.set(0)
                continue

            self._log(f"AP={ap}/{s.get('max_ap')}  pos={pos}")
            self.tick(page, ap, pos)
            time.sleep(delay)


# ---------------------------------------------------------------------------

def main():
    name     = os.environ["VAMPIRE_NAME"]
    password = os.environ["VAMPIRE_PASS"]

    start_metrics_server()

    bot = Skeleton(name, password)
    if not bot.login():
        return

    bot._get()
    s = bot.status()
    print(f"Position : {s['position']}")
    print(f"AP       : {s['ap']}/{s['max_ap']}")

    wait_for_full = os.environ.get("WAIT_FOR_FULL_AP", "true").lower() == "true"
    single_run    = os.environ.get("SINGLE_RUN",       "false").lower() == "true"

    hunter = Hunter(bot, sweep_width=int(os.environ.get("SWEEP_WIDTH", "15")))
    hunter.run(wait_for_full=wait_for_full, single_run=single_run)


if __name__ == "__main__":
    main()
