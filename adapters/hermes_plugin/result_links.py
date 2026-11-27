"""Validate declared result links without interpreting authored text as a URL."""

import re


RESOURCE_PATH = re.compile(r"/([a-z][a-z0-9-]*)/[A-Za-z0-9_-]+(?:/result|/prompt)?(?:\?revision=([1-9][0-9]*)(?:&start=(0|[1-9][0-9]*)&end=([1-9][0-9]*))?)?")
MISSING = object()


def _field(value, path, default=None):
    if not isinstance(path, str):
        return default
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            return default
        value = value[key]
    return value


def _positive(value):
    return type(value) is int and 0 < value <= 9_007_199_254_740_991


def _range(value):
    return (isinstance(value, dict) and type(value.get("start")) is int and type(value.get("end")) is int
            and 0 <= value["start"] < value["end"] <= 100_000)


def result_link(value, fields, routes, token):
    if (not isinstance(value, dict) or not isinstance(fields, dict)
            or not isinstance(fields.get("hrefField"), str) or not isinstance(fields.get("labelField"), str)):
        return None
    path = _field(value, fields["hrefField"])
    match = RESOURCE_PATH.fullmatch(path) if isinstance(path, str) and len(path) <= 2048 else None
    if not match or not isinstance(routes, list) or match[1] not in routes or token in path:
        return None
    revision = int(match[2]) if match[2] is not None else None
    if revision is not None and not _positive(revision):
        return None
    selected = {"start": int(match[3]), "end": int(match[4])} if match[3] is not None else None
    if selected is not None and not _range(selected):
        return None
    if "revisionField" in fields:
        exact = _field(value, fields["revisionField"])
        if not _positive(exact) or revision is not None and revision != exact:
            return None
        revision = exact
    if "rangeField" in fields:
        available = _field(value, fields["rangeField"], MISSING)
        if available is not MISSING:
            if not _range(available) or selected is not None and selected != available:
                return None
            selected = available
    if selected is not None and revision is None:
        return None
    path = path.split("?")[0] + (f"?revision={revision}" if revision is not None else "")
    if selected is not None:
        path += f'&start={selected["start"]}&end={selected["end"]}'
    label = _field(value, fields["labelField"])
    label = " ".join(label.replace(token, "[redacted]").split())[:300] if isinstance(label, str) else ""
    return {"path": path, "label": label}
