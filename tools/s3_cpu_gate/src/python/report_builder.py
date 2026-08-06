#!/usr/bin/env python3
from __future__ import annotations
import json,zipfile,hashlib
from pathlib import Path
from redaction import redact
from secret_scan import scan

def build(root:Path,out:Path)->None:
 reports=root/'reports'; artifacts=root/'artifacts'; artifacts.mkdir(parents=True,exist_ok=True)
 findings=scan(reports)
 if findings: raise RuntimeError(f"secret scan blocked zip: {findings}")
 files=sorted(p for p in reports.rglob('*') if p.is_file())
 checks={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
 (reports/'checksums.json').write_text(json.dumps(checks,indent=2)+'\n',encoding='utf-8')
 with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  for p in sorted(reports.rglob('*')):
   if p.is_file(): z.write(p,p.relative_to(root))
