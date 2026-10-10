#!/usr/bin/env python3
"""Static checks for build.bat (cmd.exe cannot run here, so check what can go wrong in the bytes).

    python3 web/windows/tests/check_bat.py [path\\to\\file.bat ...]

Checks: ASCII only; CRLF on every line and no bare LF (cmd mis-parses labels in LF-only batch
files); goto targets exist; no delayed expansion enabled while a path variable is assigned; any
expansion of a path variable inside a parenthesised block is quoted or delayed (an unquoted
"C:\\Program Files (x86)\\..." would close the block early); the interpreter is invoked with a
quoted path and -NoProfile -ExecutionPolicy Bypass -File; the script ends with an exit code and a
pause that can be silenced.
"""
import os
import re
import sys

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
files = sys.argv[1:] or [os.path.join(root, "build.bat")]
problems = []


def bad(f, line, msg):
    problems.append(f"{os.path.basename(f)}:{line}: {msg}")


for f in files:
    data = open(f, "rb").read()
    if any(b > 127 for b in data):
        bad(f, 0, "non-ASCII byte")
    if b"\n" in data.replace(b"\r\n", b""):
        bad(f, 0, "bare LF line ending (must be CRLF)")
    if b"\r" in data.replace(b"\r\n", b""):
        bad(f, 0, "bare CR")
    if not data.endswith(b"\r\n"):
        bad(f, 0, "file does not end with CRLF")
    text = data.decode("ascii", "replace")
    lines = text.split("\r\n")

    labels = {m.group(1).lower() for m in re.finditer(r"^:([A-Za-z0-9_]+)", text, re.M)}
    for i, ln in enumerate(lines, 1):
        for m in re.finditer(r"goto\s+:?([A-Za-z0-9_]+)", ln, re.I):
            if m.group(1).lower() not in labels and m.group(1).lower() != "eof":
                bad(f, i, f"goto target ':{m.group(1)}' does not exist")

    # delayed expansion must not be on when %~dp0 / paths are assigned
    delayed = False
    depth = 0
    for i, ln in enumerate(lines, 1):
        s = ln.strip()
        if re.match(r"(?i)rem\b", s) or s.startswith("::"):
            continue
        if re.search(r"(?i)setlocal\b.*\benabledelayedexpansion\b", s) and not re.search(r"(?i)disabledelayedexpansion", s):
            delayed = True
        if re.search(r"(?i)\bendlocal\b", s):
            delayed = False
        if delayed and re.search(r"(?i)^set\s+\"?\w+=.*%~", s):
            bad(f, i, "path assigned while delayed expansion is on (a '!' in the path would be eaten)")
        # parenthesised blocks
        opens = len(re.findall(r"\($", s)) + len(re.findall(r"\(\s*$", s))
        if depth > 0 or opens:
            for m in re.finditer(r"%(MKW_ROOT|~dp0|~f0|~0|CD)%?", ln):
                before = ln[: m.start()]
                if before.count('"') % 2 == 0 and not re.match(r"(?i)\s*rem\b", ln):
                    bad(f, i, "path variable expanded unquoted inside a ( ) block")
        depth += opens
        if s.startswith(")"):
            depth = max(depth - 1, 0)
        elif s.endswith(")") and "(" not in s:
            depth = max(depth - 1, 0)

    if not re.search(r'"%MKW_PS%"\s+-NoProfile\s+-ExecutionPolicy\s+Bypass\s+-File\s+"%MKW_ROOT%web\\windows\\build-windows\.ps1"\s+%\*', text):
        bad(f, 0, "PowerShell is not started as: \"%MKW_PS%\" -NoProfile -ExecutionPolicy Bypass -File \"...\\build-windows.ps1\" %*")
    if "pause" not in text or "MKW_NO_PAUSE" not in text:
        bad(f, 0, "no (silenceable) pause at the end")
    if not re.search(r"endlocal\s*&\s*exit\s+/b\s+%MKW_ERR%\s*\r\n$", text):
        bad(f, 0, "does not end with: endlocal & exit /b %MKW_ERR%")
    if re.search(r"(?i)\bstart\b", re.sub(r"(?im)^\s*rem.*$", "", text)):
        bad(f, 0, "unexpected 'start' (the browser is opened by the PowerShell script)")

if problems:
    print("build.bat check FAILED")
    for p in problems:
        print("  " + p)
    sys.exit(1)
print("build.bat check OK (" + ", ".join(os.path.basename(f) for f in files) + ")")
