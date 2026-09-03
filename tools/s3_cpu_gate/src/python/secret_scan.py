#!/usr/bin/env python3
from __future__ import annotations
import argparse,re,sys
from pathlib import Path
RULES={
 "PRIVATE_KEY":re.compile(r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s*(?=[A-Za-z0-9+/=\r\n]{32,})[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
 "AUTH_HEADER":re.compile(r'(?i)authorization\s*:\s*bearer\s+\S+'),
 "JWT":re.compile(r'\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b'),
 "PASSWORD_VALUE":re.compile(r'(?i)["\']?password["\']?\s*[:=]\s*["\'][^"\']{6,}["\']'),
 "SERVICE_ACCOUNT":re.compile(r'"type"\s*:\s*"service_account"'),
}
IGNORE={"secret_scan.py","redaction.py","SecretScanning.Tests.ps1"}
def scan(root:Path):
 findings=[]
 paths=[root] if root.is_file() else root.rglob('*')
 for path in paths:
  if not path.is_file() or path.name in IGNORE or '.git' in path.parts: continue
  if path.suffix.lower() in {'.zip','.png','.jpg','.exe','.dll','.tar','.gz'}: continue
  try: text=path.read_text(encoding='utf-8')
  except UnicodeDecodeError: continue
  for name,rx in RULES.items():
   for m in rx.finditer(text): findings.append({"rule":name,"path":str(path.relative_to(root)),"offset":m.start()})
 return findings
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root',type=Path,nargs='+');a=p.parse_args();f=[finding for root in a.root for finding in scan(root)]
 for x in f: print(f"{x['rule']} {x['path']} @{x['offset']}")
 raise SystemExit(1 if f else 0)
