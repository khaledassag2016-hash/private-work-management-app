#!/usr/bin/env python3
from __future__ import annotations
import re
PATTERNS = [
 re.compile(r'(?i)(authorization\s*[:=]\s*bearer\s+)[^\s"\']+'),
 re.compile(r'(?i)(password\s*[:=]\s*)[^,\s}\]]+'),
 re.compile(r'(?i)(refresh[_-]?token\s*[:=]\s*)[^,\s}\]]+'),
 re.compile(r'(?i)(access[_-]?token\s*[:=]\s*)[^,\s}\]]+'),
 re.compile(r'(?i)(id[_-]?token\s*[:=]\s*)[^,\s}\]]+'),
 re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',re.S),
 re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'),
]
def redact(text:str)->str:
    out=text
    for p in PATTERNS:
        out=p.sub(lambda m:(m.group(1) if m.lastindex else '')+'[REDACTED]',out)
    return out
