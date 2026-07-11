"""Best-effort Cloudflare edge-cache purge for the published V2 static JSON.

The V2 statics (index.json, family indexes, per-sensor files, all-sensors.json)
are served from R2 through the Cloudflare cache at https://groov-api.com/v2/*.
When we rewrite them on approve/edit/delete the Cloudflare edge keeps serving
the old copy until its TTL lapses, so a new sensor can take hours to show up in
the /database table. Purging the exact URLs we just wrote makes the change
visible immediately.

This is strictly best-effort: a purge failure (or missing creds) must never
fail the sensor write that triggered it, so every entry point swallows and logs
its own errors. Purge is a no-op when CF_API_TOKEN / CF_ZONE_ID are unset or
when running locally (IS_LOCAL), where there is no Cloudflare edge in front.
"""

import json
import os
import urllib.error
import urllib.request

# Public origin the FE reads; purge-by-URL keys off these absolute URLs.
PUBLIC_BASE = "https://groov-api.com"
V2_PREFIX = "v2"

_PURGE_ENDPOINT = "https://api.cloudflare.com/client/v4/zones/{zone_id}/purge_cache"


def _sensor_static_urls(category, grv_id):
    # Must mirror the keys written by s3_updater_v2 / removed by s3_remover_v2.
    cat = category.lower()
    return [
        f"{PUBLIC_BASE}/{V2_PREFIX}/index.json",
        f"{PUBLIC_BASE}/{V2_PREFIX}/indexes/{cat}.json",
        f"{PUBLIC_BASE}/{V2_PREFIX}/sensors/{cat}/{grv_id}.json",
        f"{PUBLIC_BASE}/{V2_PREFIX}/all-sensors.json",
    ]


def purge_urls(urls):
    """Purge the given absolute URLs from the Cloudflare edge cache.

    No-op (with a log line) when creds are absent or running locally, so callers
    never have to guard on environment.
    """
    if os.environ.get("IS_LOCAL"):
        print(f"Cloudflare purge skipped (IS_LOCAL): {urls}")
        return

    token = os.environ.get("CF_API_TOKEN")
    zone_id = os.environ.get("CF_ZONE_ID")
    if not token or not zone_id:
        print("Cloudflare purge skipped: CF_API_TOKEN / CF_ZONE_ID not set")
        return

    payload = json.dumps({"files": urls}).encode("utf-8")
    req = urllib.request.Request(
        _PURGE_ENDPOINT.format(zone_id=zone_id),
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read() or b"{}")
        if body.get("success"):
            print(f"Cloudflare purge ok for {len(urls)} url(s)")
        else:
            print(f"Cloudflare purge returned errors: {body.get('errors')}")
    except urllib.error.HTTPError as err:
        print(f"Cloudflare purge HTTP {err.code}: {err.read()!r}")
    except Exception as err:
        print(f"Cloudflare purge failed: {err}")


def purge_sensor_statics(category, grv_id):
    """Purge the four static files touched by a single-sensor write or removal."""
    try:
        purge_urls(_sensor_static_urls(category, grv_id))
    except Exception as err:
        # Defensive: purge_urls already swallows, but never let this bubble into
        # the caller's write path.
        print(f"Cloudflare purge_sensor_statics failed: {err}")
