"""Shared HTTP helpers: a retrying session and a small JSON file cache."""
from __future__ import annotations

import json
import os
import time
import random
import threading

import requests

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

_local = threading.local()


def session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Accept": "*/*"})
        _local.s = s
    return s


def get(url, *, kind="text", timeout=25, tries=5, json_body=None,
        backoff=1.6, ok_status=(200,)):
    """GET (or POST when json_body given) with exponential backoff.

    Returns response text, or parsed JSON when kind="json".
    Raises the last error if every attempt fails.
    """
    last = None
    for i in range(tries):
        try:
            if json_body is not None:
                r = session().post(url, json=json_body, timeout=timeout)
            else:
                r = session().get(url, timeout=timeout)
            if r.status_code not in ok_status:
                raise RuntimeError(f"HTTP {r.status_code} for {url}")
            return r.json() if kind == "json" else r.text
        except Exception as e:  # noqa: BLE001 - network is messy, retry all
            last = e
            if i == tries - 1:
                break
            time.sleep((backoff ** i) + random.uniform(0, 0.4))
    raise last


def cache_get(cache_dir, key):
    p = os.path.join(cache_dir, key + ".json")
    if os.path.exists(p):
        try:
            with open(p, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:  # noqa: BLE001 - corrupt cache entry, re-fetch
            return None
    return None


def cache_put(cache_dir, key, value):
    os.makedirs(cache_dir, exist_ok=True)
    p = os.path.join(cache_dir, key + ".json")
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f, separators=(",", ":"), ensure_ascii=False)
    os.replace(tmp, p)
