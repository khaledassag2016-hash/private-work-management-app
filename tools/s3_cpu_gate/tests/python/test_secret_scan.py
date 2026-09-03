import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[2]/'src'/'python'))
from secret_scan import scan

def test_clean(tmp_path): (tmp_path/'a.txt').write_text('safe'); assert scan(tmp_path)==[]
def test_parser_marker_is_not_a_private_key(tmp_path):
    (tmp_path/'a.txt').write_text('marker = "-----BEGIN " + "PRIVATE KEY-----"')
    assert scan(tmp_path)==[]
def test_private_key_fixture_still_detected(tmp_path):
    body = 'A' * 64
    begin = '-----BEGIN ' + 'PRIVATE KEY-----'
    end = '-----END ' + 'PRIVATE KEY-----'
    (tmp_path/'a.txt').write_text(begin + '\n' + body + '\n' + end)
    assert scan(tmp_path)
def test_private_key_variants_still_detected(tmp_path):
    for kind in ('RSA ', 'EC ', 'OPENSSH '):
        payload = tmp_path / (kind.strip().lower() + '.txt')
        payload.write_text('-----BEGIN ' + kind + 'PRIVATE KEY-----\n' + ('C' * 64) + '\n-----END ' + kind + 'PRIVATE KEY-----')
    assert {finding['rule'] for finding in scan(tmp_path)} == {'PRIVATE_KEY'}
def test_service_account(tmp_path): (tmp_path/'a.json').write_text('{"type":"service_'+'account"}'); assert scan(tmp_path)
def test_binary_ignored(tmp_path): (tmp_path/'a.zip').write_bytes(('-----BEGIN '+'PRIVATE KEY-----').encode()); assert scan(tmp_path)==[]
def test_single_allowlisted_file_is_scanned(tmp_path):
    begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
    end = '-----END ' + 'RSA PRIVATE KEY-----'
    payload=tmp_path/'worker.js'; payload.write_text(begin + '\n' + ('B' * 64) + '\n' + end)
    assert scan(payload)
