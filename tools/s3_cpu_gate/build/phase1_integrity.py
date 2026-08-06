#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, re, zipfile
from pathlib import Path, PurePosixPath

REQUIRED=[
 "src/version-manifest.json","src/S3-CpuGate-Orchestrator.ps1","src/modules/Common.psm1","src/modules/CpuGate.psm1",
 "tests/pester/TestHelper.ps1","tests/pester/CpuGate.Tests.ps1","tests/python/test_phase1_integrity.py",
 "validation/run_python_tests.py","settings/PSScriptAnalyzerSettings.psd1"
]

def sha(path:Path): return hashlib.sha256(path.read_bytes()).hexdigest()

def validate(root:Path):
 errors=[]
 for rel in REQUIRED:
  if not (root/rel).is_file(): errors.append(f"MISSING:{rel}")
 manifest_path=root/'src/version-manifest.json'
 if manifest_path.is_file():
  try:
   manifest=json.loads(manifest_path.read_text(encoding='utf-8-sig'))
   if manifest.get('authoritative') is not True: errors.append('VERSION_MANIFEST_NOT_AUTHORITATIVE')
  except Exception as exc: errors.append(f'VERSION_MANIFEST_INVALID:{exc}')
 for test in (root/'tests/pester').glob('*.Tests.ps1') if (root/'tests/pester').is_dir() else []:
  text=test.read_text(encoding='utf-8-sig')
  if 'TestHelper.ps1' in text and not (test.parent/'TestHelper.ps1').is_file(): errors.append(f'DOT_SOURCE_MISSING:{test}')
 helper=root/'tests/pester/TestHelper.ps1'
 if helper.is_file():
  text=helper.read_text(encoding='utf-8-sig');m=re.search(r"foreach\(\$name in @\((.*?)\)\)",text,re.S)
  if not m: errors.append('MODULE_LIST_NOT_FOUND')
  else:
   for name in re.findall(r"'([^']+)'",m.group(1)):
    if not (root/f'src/modules/{name}.psm1').is_file(): errors.append(f'MODULE_MISSING:{name}')
 return errors

def make_zip(root:Path,dest:Path):
 dest.parent.mkdir(parents=True,exist_ok=True)
 with zipfile.ZipFile(dest,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for path in sorted(p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and '.pytest_cache' not in p.parts and p.suffix!='.pyc'):
   rel=path.relative_to(root).as_posix();z.write(path,rel)

def zip_safety(path:Path):
 errors=[];seen=set()
 with zipfile.ZipFile(path) as z:
  for info in z.infolist():
   name=info.filename;p=PurePosixPath(name)
   if name in seen: errors.append(f'DUPLICATE:{name}')
   seen.add(name)
   if p.is_absolute() or '..' in p.parts or '\\' in name: errors.append(f'UNSAFE:{name}')
 return errors

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--report',type=Path,required=True);p.add_argument('--zip-out',type=Path);a=p.parse_args()
 root=a.root.resolve();errors=validate(root);zip_errors=[]
 if a.zip_out:
  make_zip(root,a.zip_out);zip_errors=zip_safety(a.zip_out);errors.extend(zip_errors)
 payload={'status':'PASS' if not errors else 'FAIL','root':str(root),'files':len([x for x in root.rglob('*') if x.is_file()]),'errors':errors,'zip':str(a.zip_out) if a.zip_out else None,'zipSha256':sha(a.zip_out) if a.zip_out else None}
 a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8');print(f"PHASE1 INTEGRITY: {payload['status']}");raise SystemExit(1 if errors else 0)
if __name__=='__main__':main()
