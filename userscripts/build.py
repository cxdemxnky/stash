#!/usr/bin/env python3
"""Build the Tampermonkey userscripts into the userscripts Stash plugin.

Each script = metadata block + site helpers + site adapter + core, with the
downloader address and token from ~/.config/stash-downloader/env baked in as
defaults (they can be changed from the Tampermonkey menu).

    python3 userscripts/build.py [--service http://HOST:10141]
"""
import argparse
import json
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")
OUT = os.path.join(HERE, "..", "plugins", "userscripts", "app", "scripts")
VERSION = "1.0.5"

SCRIPTS = [
    {
        "id": "playboytv",
        "name": "Stash downloader: PlayboyTV",
        "description": "Select PlayboyTV episodes or whole shows (all seasons) and download them into Stash.",
        "match": ["https://members.playboytv.com/*"],
        "parts": ["gamma.js", "playboytv.js"],
    },
    {
        "id": "adulttime",
        "name": "Stash downloader: AdultTime",
        "description": "Select AdultTime videos and download them into Stash, tagged with all performers.",
        "match": ["https://members.adulttime.com/*"],
        "parts": ["gamma.js", "adulttime.js"],
    },
]


def lan_ip():
    """This machine's LAN address, preferring 192.168/172.16/10 ranges on non-VPN interfaces."""
    out = subprocess.run(["ip", "-4", "-o", "addr"], capture_output=True, text=True).stdout
    addrs = []
    for line in out.splitlines():
        parts = line.split()
        iface, ip = parts[1], parts[3].split("/")[0]
        if ip.startswith("127.") or re.match(r"(tun|tap|wg|nordlynx|docker|br-|veth|virbr)", iface):
            continue
        addrs.append(ip)
    for pattern in (r"192\.168\.", r"172\.(1[6-9]|2\d|3[01])\.", r"10\."):
        for ip in addrs:
            if re.match(pattern, ip):
                return ip
    return addrs[0] if addrs else "localhost"


def read_token():
    path = os.path.expanduser("~/.config/stash-downloader/env")
    if not os.path.exists(path):
        return ""
    for line in open(path):
        if line.startswith("DOWNLOADER_TOKEN="):
            return line.split("=", 1)[1].strip()
    return ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", default="http://%s:10141" % lan_ip())
    ap.add_argument("--stash", default="http://%s:10140" % lan_ip(),
                    help="Stash address the scripts are served from (for Tampermonkey updates)")
    args = ap.parse_args()
    token = read_token()
    core = open(os.path.join(SRC, "core.js")).read()
    os.makedirs(OUT, exist_ok=True)

    index = []
    for s in SCRIPTS:
        meta = ["// ==UserScript==",
                "// @name         " + s["name"],
                "// @namespace    stash-downloader",
                "// @version      " + VERSION,
                "// @description  " + s["description"]]
        meta += ["// @match        " + m for m in s["match"]]
        script_url = "%s/plugin/userscripts/assets/scripts/%s.user.js" % (args.stash, s["id"])
        meta += ["// @downloadURL  " + script_url, "// @updateURL    " + script_url]
        meta += [
            "// @run-at       document-start",
            "// @sandbox      JavaScript",
            "// @inject-into  page",
            "// @grant        unsafeWindow",
            "// @grant        GM_getValue",
            "// @grant        GM_setValue",
            "// @grant        GM_xmlhttpRequest",
            "// @grant        GM_registerMenuCommand",
            "// @grant        GM_addStyle",
            "// @connect      *",
            "// ==/UserScript==",
        ]
        body = "\n".join(open(os.path.join(SRC, p)).read() for p in s["parts"]) + "\n" + core
        body = body.replace("__SERVICE_URL__", args.service).replace("__TOKEN__", token)
        fname = s["id"] + ".user.js"
        with open(os.path.join(OUT, fname), "w") as f:
            f.write("\n".join(meta) + "\n\n" + body)
        index.append({"id": s["id"], "name": s["name"], "description": s["description"],
                      "file": "scripts/" + fname, "match": s["match"], "version": VERSION})
        print("built", fname)

    with open(os.path.join(OUT, "index.json"), "w") as f:
        json.dump({"service": args.service, "scripts": index}, f, indent=1)


if __name__ == "__main__":
    main()
