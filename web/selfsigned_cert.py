"""Self-signed TLS certificate for web/serve.py --https (Python 3.8+ standard library only).

    ensure_certificate(cert_dir, extra_names=()) -> Certificate(cert_path, key_path, sans, generated, backend)

The certificate is valid for localhost, 127.0.0.1, ::1, this machine's host name and its LAN IPv4
addresses (plus anything in `extra_names`), is created on first use and cached in `cert_dir`
(a `.json` file next to it remembers the names, so the certificate is made again when the machine
gets a new LAN address or when it is about to expire).

Backends: `openssl req -x509` when an `openssl` command works, otherwise a small pure-Python
generator (ECDSA P-256 key, X.509 v3 in DER, SHA-256 signature). The Python one exists because the
standard library cannot create certificates and Windows/macOS hosts often have no usable openssl.
It is meant for this one job: a throw-away key for a LAN test server, not general use (the scalar
multiplication is not constant time).
"""

import base64
import datetime
import hashlib
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from collections import namedtuple

CERT_NAME = "serve-cert.pem"
KEY_NAME = "serve-key.pem"
META_NAME = "serve-cert.json"
VALID_DAYS = 365
RENEW_BEFORE_DAYS = 30
MAX_NAMES = 64

Certificate = namedtuple("Certificate", "cert_path key_path sans generated backend")


# --------------------------------------------------------------------------------------------
# Which names/addresses the certificate must cover
# --------------------------------------------------------------------------------------------
def _usable_ipv4(text):
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return None
    if ip.version != 4 or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
        return None
    return str(ip)


def lan_addresses():
    """This machine's non-loopback IPv4 addresses, best guess first. Never raises."""
    found = []

    def add(text):
        ip = _usable_ipv4(text)
        if ip and ip not in found:
            found.append(ip)

    # The address the OS would use to reach the internet (no packet is sent for a UDP connect).
    for probe in ("198.51.100.1", "10.255.255.255", "8.8.8.8"):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect((probe, 9))
                add(s.getsockname()[0])
        except OSError:
            continue
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            add(info[4][0])
    except OSError:
        pass
    # Every interface (a machine can be on Wi-Fi and Ethernet and VPNs at once).
    for command, pattern in ((["ip", "-o", "-4", "addr", "show"], r"\binet (\d+\.\d+\.\d+\.\d+)"),
                             (["ifconfig"], r"\binet (?:addr:)?(\d+\.\d+\.\d+\.\d+)"),
                             (["ipconfig"], r"IPv4[^:\n]*:\s*(\d+\.\d+\.\d+\.\d+)")):
        if not shutil.which(command[0]):
            continue
        try:
            out = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5,
                                 universal_newlines=True, errors="replace").stdout
        except (OSError, subprocess.SubprocessError):
            continue
        for match in re.finditer(pattern, out):
            add(match.group(1))
    return found


def wanted_names(extra_names=()):
    """(dns_names, ip_addresses) the certificate has to be valid for."""
    dns = ["localhost"]
    ips = ["127.0.0.1", "::1"]
    try:
        host = socket.gethostname()
        if host and host != "localhost":
            dns.append(host)
            for suffix in (".local", ".lan"):
                if "." not in host:
                    dns.append(host + suffix)
    except OSError:
        pass
    for ip in lan_addresses():
        ips.append(ip)
    for name in extra_names:
        name = name.strip()
        if not name:
            continue
        try:
            ips.append(str(ipaddress.ip_address(name.strip("[]"))))
        except ValueError:
            dns.append(name.lower())
    seen = set()
    dns = [n for n in dns if not (n in seen or seen.add(n)) and _valid_dns_name(n)]
    seen = set()
    ips = [i for i in ips if not (i in seen or seen.add(i))]
    return dns, ips


def _valid_dns_name(name):
    if not name or len(name) > 253:
        return False
    if name.startswith("*."):
        name = name[2:]
    return all(re.fullmatch(r"[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?", label) for label in name.split("."))


def _san_strings(dns, ips):
    return ["DNS:" + d for d in dns] + ["IP:" + i for i in ips]


# --------------------------------------------------------------------------------------------
# OpenSSL backend
# --------------------------------------------------------------------------------------------
def generate_with_openssl(cert_path, key_path, dns, ips, days=VALID_DAYS):
    """Runs `openssl req -x509`; returns True on success, False if openssl is missing or fails."""
    exe = shutil.which("openssl")
    if not exe:
        return False
    cn = (dns[1] if len(dns) > 1 else "localhost")[:60]
    command = [
        exe, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-sha256", "-days", str(days), "-subj", "/CN=" + cn,
        "-keyout", key_path, "-out", cert_path,
        "-addext", "subjectAltName=" + ",".join(_san_strings(dns, ips)),
        "-addext", "basicConstraints=critical,CA:FALSE",
        "-addext", "keyUsage=critical,digitalSignature",
        "-addext", "extendedKeyUsage=serverAuth",
    ]
    try:
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0 or not os.path.getsize(cert_path) or not os.path.getsize(key_path):
        for path in (cert_path, key_path):
            try:
                os.remove(path)
            except OSError:
                pass
        return False
    return True


# --------------------------------------------------------------------------------------------
# Pure-Python backend: ECDSA P-256 + X.509 DER
# --------------------------------------------------------------------------------------------
_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFF
_A = _P - 3
_B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604B
_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296
_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5
_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551
_G = (_GX, _GY)


def _point_add(p1, p2):
    if p1 is None:
        return p2
    if p2 is None:
        return p1
    x1, y1 = p1
    x2, y2 = p2
    if x1 == x2:
        if (y1 + y2) % _P == 0:
            return None
        slope = (3 * x1 * x1 + _A) * pow(2 * y1, -1, _P) % _P
    else:
        slope = (y2 - y1) * pow(x2 - x1, -1, _P) % _P
    x3 = (slope * slope - x1 - x2) % _P
    return x3, (slope * (x1 - x3) - y1) % _P


def _scalar_mult(k, point):
    result = None
    addend = point
    while k:
        if k & 1:
            result = _point_add(result, addend)
        addend = _point_add(addend, addend)
        k >>= 1
    return result


def _on_curve(point):
    x, y = point
    return (y * y - (x * x * x + _A * x + _B)) % _P == 0


def ecdsa_sign(private, message):
    """DER-free (r, s) ECDSA signature of SHA-256(message) with the P-256 key `private`."""
    e = int.from_bytes(hashlib.sha256(message).digest(), "big")
    while True:
        k = secrets.randbelow(_N - 1) + 1
        r = _scalar_mult(k, _G)[0] % _N
        if r == 0:
            continue
        s = pow(k, -1, _N) * (e + r * private) % _N
        if s == 0:
            continue
        return r, min(s, _N - s)  # low-s form


def _der_len(n):
    if n < 0x80:
        return bytes([n])
    body = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(body)]) + body


def _tlv(tag, body):
    return bytes([tag]) + _der_len(len(body)) + body


def _seq(*parts):
    return _tlv(0x30, b"".join(parts))


def _int(n):
    body = n.to_bytes(max(1, (n.bit_length() + 8) // 8), "big")  # leading 0x00 when the top bit is set
    return _tlv(0x02, body)


def _oid(dotted):
    arcs = [int(a) for a in dotted.split(".")]
    out = bytearray([40 * arcs[0] + arcs[1]])
    for arc in arcs[2:]:
        chunk = [arc & 0x7F]
        arc >>= 7
        while arc:
            chunk.append(0x80 | (arc & 0x7F))
            arc >>= 7
        out += bytes(reversed(chunk))
    return _tlv(0x06, bytes(out))


def _bitstring(data, unused=0):
    return _tlv(0x03, bytes([unused]) + data)


def _utctime(dt):
    return _tlv(0x17, dt.strftime("%y%m%d%H%M%SZ").encode("ascii"))


_OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2"
_OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1"
_OID_P256 = "1.2.840.10045.3.1.7"
_OID_CN = "2.5.4.3"


def _extension(oid, value_der, critical=False):
    parts = [_oid(oid)]
    if critical:
        parts.append(_tlv(0x01, b"\xff"))
    parts.append(_tlv(0x04, value_der))
    return _seq(*parts)


def build_certificate_der(private, common_name, dns, ips, days=VALID_DAYS, now=None):
    """Self-signed X.509 v3 certificate (DER bytes) for the P-256 key `private`."""
    pub = _scalar_mult(private, _G)
    pub_bytes = b"\x04" + pub[0].to_bytes(32, "big") + pub[1].to_bytes(32, "big")
    now = now or datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    not_before = now - datetime.timedelta(days=1)  # tolerate devices whose clock runs behind
    not_after = now + datetime.timedelta(days=days)
    name = _seq(_tlv(0x31, _seq(_oid(_OID_CN), _tlv(0x0C, common_name.encode("utf8")))))
    alg = _seq(_oid(_OID_ECDSA_SHA256))
    spki = _seq(_seq(_oid(_OID_EC_PUBLIC_KEY), _oid(_OID_P256)), _bitstring(pub_bytes))
    key_id = hashlib.sha1(pub_bytes).digest()

    general_names = [_tlv(0x82, d.encode("ascii")) for d in dns]
    general_names += [_tlv(0x87, ipaddress.ip_address(i).packed) for i in ips]
    extensions = _seq(
        _extension("2.5.29.19", _seq(), critical=True),                    # basicConstraints: CA false
        _extension("2.5.29.15", _bitstring(b"\x80", 7), critical=True),    # keyUsage: digitalSignature
        _extension("2.5.29.37", _seq(_oid("1.3.6.1.5.5.7.3.1"))),          # extKeyUsage: serverAuth
        _extension("2.5.29.17", _seq(*general_names)),                     # subjectAltName
        _extension("2.5.29.14", _tlv(0x04, key_id)),                       # subjectKeyIdentifier
        _extension("2.5.29.35", _seq(_tlv(0x80, key_id))),                 # authorityKeyIdentifier
    )
    tbs = _seq(
        _tlv(0xA0, _int(2)),                       # version: v3
        _int(secrets.randbits(120) | (1 << 119)),  # serial: positive, 120 bits
        alg,
        name,                                      # issuer == subject: self-signed
        _seq(_utctime(not_before), _utctime(not_after)),
        name,
        spki,
        _tlv(0xA3, extensions),
    )
    r, s = ecdsa_sign(private, tbs)
    return _seq(tbs, alg, _bitstring(_seq(_int(r), _int(s))))


def _pem(label, der):
    b64 = base64.b64encode(der).decode("ascii")
    lines = [b64[i:i + 64] for i in range(0, len(b64), 64)]
    return "-----BEGIN %s-----\n%s\n-----END %s-----\n" % (label, "\n".join(lines), label)


def generate_pure_python(cert_path, key_path, dns, ips, days=VALID_DAYS):
    private = secrets.randbelow(_N - 1) + 1
    pub = _scalar_mult(private, _G)
    assert _on_curve(pub)
    pub_bytes = b"\x04" + pub[0].to_bytes(32, "big") + pub[1].to_bytes(32, "big")
    cn = (dns[1] if len(dns) > 1 else "localhost")[:60]
    cert = build_certificate_der(private, cn, dns, ips, days)
    # RFC 5915 ECPrivateKey: version, private key, named curve, public key.
    key = _seq(_int(1), _tlv(0x04, private.to_bytes(32, "big")),
               _tlv(0xA0, _oid(_OID_P256)), _tlv(0xA1, _bitstring(pub_bytes)))
    _write_private(key_path, _pem("EC PRIVATE KEY", key))
    with open(cert_path, "w", newline="\n") as f:
        f.write(_pem("CERTIFICATE", cert))


def _write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", newline="\n") as f:
        f.write(text)


# --------------------------------------------------------------------------------------------
# Cache
# --------------------------------------------------------------------------------------------
def _read_meta(path):
    try:
        with open(path, "r") as f:
            meta = json.load(f)
        return meta if isinstance(meta, dict) else None
    except (OSError, ValueError):
        return None


def ensure_certificate(cert_dir, extra_names=(), backend="auto", log=None, now=None):
    """Returns the cached certificate in `cert_dir`, creating or renewing it when needed.

    backend: "auto" (openssl, else Python), "openssl" or "python".
    """
    say = log or (lambda message: None)
    os.makedirs(cert_dir, exist_ok=True)
    cert_path = os.path.join(cert_dir, CERT_NAME)
    key_path = os.path.join(cert_dir, KEY_NAME)
    meta_path = os.path.join(cert_dir, META_NAME)
    dns, ips = wanted_names(extra_names)
    wanted = set(_san_strings(dns, ips))
    now_ts = time.time() if now is None else now

    meta = _read_meta(meta_path)
    if (meta and os.path.isfile(cert_path) and os.path.isfile(key_path)
            and isinstance(meta.get("sans"), list) and isinstance(meta.get("not_after"), (int, float))
            and wanted <= set(meta["sans"]) and meta["not_after"] - now_ts > RENEW_BEFORE_DAYS * 86400):
        return Certificate(cert_path, key_path, list(meta["sans"]), False, str(meta.get("backend", "?")))

    # Keep names from the previous certificate too, so a network that comes and goes (VPN, docking
    # station) does not make a new certificate, and the browser warning, every time.
    if meta and isinstance(meta.get("sans"), list):
        old = [s for s in meta["sans"] if isinstance(s, str)]
        dns += [s[4:] for s in old if s.startswith("DNS:") and s[4:] not in dns and _valid_dns_name(s[4:])]
        ips += [s[3:] for s in old if s.startswith("IP:") and s[3:] not in ips]
    dns, ips = dns[:MAX_NAMES // 2], ips[:MAX_NAMES // 2]

    used = None
    tmp = tempfile.mkdtemp(prefix="gen-", dir=cert_dir)
    try:
        tmp_cert, tmp_key = os.path.join(tmp, CERT_NAME), os.path.join(tmp, KEY_NAME)
        if backend in ("auto", "openssl") and generate_with_openssl(tmp_cert, tmp_key, dns, ips):
            used = "openssl"
        elif backend == "openssl":
            raise RuntimeError("openssl is not available or failed")
        else:
            generate_pure_python(tmp_cert, tmp_key, dns, ips)
            used = "python"
        os.chmod(tmp_key, 0o600)
        os.replace(tmp_key, key_path)
        os.replace(tmp_cert, cert_path)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    sans = _san_strings(dns, ips)
    with open(meta_path, "w") as f:
        json.dump({"sans": sans, "not_after": now_ts + VALID_DAYS * 86400, "backend": used}, f)
    say("created a self-signed certificate (%s) valid for %d days" % (used, VALID_DAYS))
    return Certificate(cert_path, key_path, sans, True, used)


def fingerprint_sha256(cert_path):
    """'AB:CD:...' SHA-256 fingerprint of the first certificate in a PEM file."""
    with open(cert_path, "r") as f:
        text = f.read()
    match = re.search(r"-----BEGIN CERTIFICATE-----(.*?)-----END CERTIFICATE-----", text, re.S)
    if not match:
        return None
    digest = hashlib.sha256(base64.b64decode("".join(match.group(1).split()))).hexdigest().upper()
    return ":".join(digest[i:i + 2] for i in range(0, len(digest), 2))


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    result = ensure_certificate(out, sys.argv[2:], log=print)
    print(result.cert_path, result.key_path)
    print("\n".join(result.sans))
