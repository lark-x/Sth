"""Store Sth connections and delivery dates inside the active Hermes profile."""

import ctypes
import json
import os
import re
import secrets
import stat
import tempfile
from datetime import date
from pathlib import Path


TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")


def valid_claim(value):
    if not isinstance(value, dict):
        return False
    token, connection = value.get("token"), value.get("connectionId")
    return (isinstance(token, str) and TOKEN.fullmatch(token) is not None
            and isinstance(connection, str) and 0 < len(connection) <= 512 and connection.isprintable())


def _private(path, expected_type):
    state = path.lstat()
    if not expected_type(state.st_mode) or getattr(state, "st_file_attributes", 0) & 0x400:
        raise OSError("Expected a regular binding path.")
    if os.name != "nt" and (state.st_uid != os.getuid() or state.st_mode & 0o077):
        raise OSError("Binding paths must be private to the Hermes user.")
    return state


def binding_directory():
    from hermes_cli.config import get_env_value
    from hermes_constants import get_hermes_home

    name = get_env_value("STH_PERSONAL_OPERATIONS_STORAGE_DIR") or "sth-personal-operations"
    if not re.fullmatch(r"sth-personal-operations(?:-[a-z0-9]+)*", name):
        raise ValueError("Expected a Sth storage directory name within the Hermes profile.")
    return Path(get_hermes_home()) / name


def prepare_storage(*, check_write=False):
    directory = binding_directory()
    directory.mkdir(mode=0o700, exist_ok=True)
    _private(directory, stat.S_ISDIR)
    if check_write:
        probe = directory / f".write-check-{secrets.token_hex(16)}"
        with probe.open("xb"):
            pass
        probe.unlink()
    return directory


def _dpapi(data, protect):
    from ctypes import wintypes

    class Blob(ctypes.Structure):
        _fields_ = [("size", wintypes.DWORD), ("data", ctypes.POINTER(ctypes.c_char))]

    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))
    output = Blob()
    crypto = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    transform = crypto.CryptProtectData if protect else crypto.CryptUnprotectData
    transform.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p,
                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    if not transform(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        kernel.LocalFree(output.data)


def read_binding(key):
    directory = binding_directory()
    path = directory / f"{key}.binding"
    try:
        _private(directory, stat.S_ISDIR)
        if _private(path, stat.S_ISREG).st_size > 32768:
            return None
        data = path.read_bytes()
        value = json.loads(_dpapi(data, protect=False) if os.name == "nt" else data)
        if valid_claim(value) and value.get("key") == key:
            return value
    except (OSError, ValueError):
        pass
    return None


def _store(directory, path, data, *, replace):
    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as pending:
        staged = Path(pending.name)
        try:
            pending.write(data)
            pending.flush()
            os.fsync(pending.fileno())
            pending.close()
            if replace:
                staged.replace(path)
            else:
                try:
                    os.link(staged, path)
                except FileExistsError:
                    pass
        finally:
            pending.close()
            staged.unlink(missing_ok=True)


def save_binding(key, claim, delivery, *, origin=None):
    directory = prepare_storage()
    value = {"key": key, "connectMessage": delivery,
             "token": claim["token"], "connectionId": claim["connectionId"]}
    if origin is not None:
        value["origin"] = origin
    data = json.dumps(value).encode()
    if os.name == "nt":
        data = _dpapi(data, protect=True)
    _store(directory, directory / f"{key}.binding", data, replace=True)


def stable_date(key, today):
    directory = prepare_storage()
    path = directory / f"{key}.date"
    if not path.exists():
        _store(directory, path, today.encode("ascii"), replace=False)
    if _private(path, stat.S_ISREG).st_size != 10:
        raise ValueError("Invalid stored delivery date.")
    return date.fromisoformat(path.read_text(encoding="ascii")).isoformat()
