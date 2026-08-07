#!/usr/bin/env python3
from __future__ import annotations
import argparse, hashlib, json, re, zipfile
from pathlib import Path, PurePosixPath

PACKAGE_MANIFEST = "package-manifest.json"
FORBIDDEN_PARTS = {"__pycache__", ".pytest_cache", ".mypy_cache", ".venv", ".git"}
FORBIDDEN_SUFFIXES = {".pyc", ".pyo", ".tmp", ".bak", ".swp"}
FORBIDDEN_NAMES = {".env", ".env.local", "credentials.json", "token.json", "auth.json"}

def unsafe_path(name: str) -> bool:
 p = PurePosixPath(name)
 return p.is_absolute() or ".." in p.parts or "\\" in name or bool(re.match(r"^[A-Za-z]:/", name))

def resolve_entry(root: Path, name: str) -> Path:
 if not isinstance(name, str) or unsafe_path(name):
  raise ValueError(f"UNSAFE_MANIFEST_PATH:{name}")
 root_resolved = root.resolve()
 candidate = (root_resolved / name).resolve()
 try:
  candidate.relative_to(root_resolved)
 except ValueError as exc:
  raise ValueError(f"PATH_OUTSIDE_ROOT:{name}") from exc
 return candidate

def sha(path:Path): return hashlib.sha256(path.read_bytes()).hexdigest()

def validate(root:Path):
 errors=[]
 manifest_file = root / PACKAGE_MANIFEST
 if not manifest_file.is_file():
  return [f"MISSING:{PACKAGE_MANIFEST}"]
 try:
  package_manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
  allowed = package_manifest["files"]
  if package_manifest.get("schemaVersion") != 1: errors.append("PACKAGE_MANIFEST_SCHEMA")
  if package_manifest.get("integrityAlgorithm") != "sha256": errors.append("PACKAGE_MANIFEST_ALGORITHM")
  if package_manifest.get("versionManifest") != "src/version-manifest.json": errors.append("PACKAGE_MANIFEST_VERSION_PATH")
  if len(allowed) != len(set(allowed)): errors.append("PACKAGE_MANIFEST_DUPLICATE")
  for rel in allowed:
   try: p = resolve_entry(root, rel)
   except ValueError:
    errors.append(f"UNSAFE_MANIFEST_PATH:{rel}"); continue
   if not p.is_file(): errors.append(f"MISSING:{rel}")
 except (OSError, TypeError, ValueError, KeyError) as exc:
  errors.append(f"PACKAGE_MANIFEST_INVALID:{exc}")
  allowed = []
 tracked = {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()}
 expected = set(allowed) | {PACKAGE_MANIFEST}
 for rel in sorted(tracked - expected): errors.append(f"UNALLOWLISTED:{rel}")
 for rel in sorted(tracked):
  path = PurePosixPath(rel)
  if set(path.parts) & FORBIDDEN_PARTS or path.suffix.lower() in FORBIDDEN_SUFFIXES or path.name.lower() in FORBIDDEN_NAMES:
   errors.append(f"FORBIDDEN_FILE:{rel}")
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
 package_manifest=json.loads((root/PACKAGE_MANIFEST).read_text(encoding='utf-8'))
 entries=sorted([PACKAGE_MANIFEST] + package_manifest["files"])
 resolved_entries=[(rel,resolve_entry(root,rel)) for rel in entries]
 with zipfile.ZipFile(dest,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for rel,path in resolved_entries:
   info=zipfile.ZipInfo(rel,date_time=(1980,1,1,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED
   z.writestr(info,path.read_bytes())

def zip_safety(path:Path):
 errors=[];seen=set()
 with zipfile.ZipFile(path) as z:
  for info in z.infolist():
   name=info.filename;p=PurePosixPath(name)
   if name in seen: errors.append(f'DUPLICATE:{name}')
   seen.add(name)
   if unsafe_path(name): errors.append(f'UNSAFE:{name}')
 return errors

def main():
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--report',type=Path,required=True);p.add_argument('--zip-out',type=Path);a=p.parse_args()
 root=a.root.resolve();errors=validate(root);zip_errors=[]
 if a.zip_out and not errors:
  try:
   make_zip(root,a.zip_out);zip_errors=zip_safety(a.zip_out);errors.extend(zip_errors)
  except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
   errors.append(f"ZIP_BUILD_FAILED:{exc}")
 payload={'status':'PASS' if not errors else 'FAIL','root':str(root),'files':len([x for x in root.rglob('*') if x.is_file()]),'errors':errors,'zip':str(a.zip_out) if a.zip_out else None,'zipSha256':sha(a.zip_out) if a.zip_out and a.zip_out.is_file() and not errors else None}
 a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8');print(f"PHASE1 INTEGRITY: {payload['status']}");raise SystemExit(1 if errors else 0)
if __name__=='__main__':main()
