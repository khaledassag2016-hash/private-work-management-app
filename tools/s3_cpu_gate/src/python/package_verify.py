#!/usr/bin/env python3
from __future__ import annotations
import argparse,hashlib,json
from pathlib import Path

def sha256(p:Path)->str:
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def verify(root:Path,manifest:Path):
 data=json.loads(manifest.read_text(encoding='utf-8')); errors=[]
 for e in data['files']:
  p=root/e['path']
  if not p.is_file(): errors.append(f"MISSING:{e['path']}")
  elif sha256(p)!=e['sha256']: errors.append(f"HASH:{e['path']}")
 return errors
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('root',type=Path);p.add_argument('manifest',type=Path);a=p.parse_args()
 e=verify(a.root,a.manifest); print('\n'.join(e) if e else 'PACKAGE: PASS');raise SystemExit(1 if e else 0)
