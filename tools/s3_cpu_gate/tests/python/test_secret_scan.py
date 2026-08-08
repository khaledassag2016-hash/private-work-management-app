import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[2]/'src'/'python'))
from secret_scan import scan

def test_clean(tmp_path): (tmp_path/'a.txt').write_text('safe'); assert scan(tmp_path)==[]
def test_private_key(tmp_path): (tmp_path/'a.txt').write_text('-----BEGIN '+'PRIVATE KEY-----'); assert scan(tmp_path)
def test_service_account(tmp_path): (tmp_path/'a.json').write_text('{"type":"service_'+'account"}'); assert scan(tmp_path)
def test_binary_ignored(tmp_path): (tmp_path/'a.zip').write_bytes(('-----BEGIN '+'PRIVATE KEY-----').encode()); assert scan(tmp_path)==[]
def test_single_allowlisted_file_is_scanned(tmp_path):
    payload=tmp_path/'worker.js'; payload.write_text('-----BEGIN '+'PRIVATE KEY-----')
    assert scan(payload)
