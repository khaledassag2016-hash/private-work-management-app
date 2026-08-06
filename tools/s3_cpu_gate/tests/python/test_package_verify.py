import sys,json,hashlib
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[2]/'src'/'python'))
from package_verify import verify

def test_verify_ok(tmp_path):
 p=tmp_path/'x';p.write_text('x');h=hashlib.sha256(b'x').hexdigest();m=tmp_path/'m.json';m.write_text(json.dumps({'files':[{'path':'x','sha256':h}]}));assert verify(tmp_path,m)==[]
def test_verify_missing(tmp_path):
 m=tmp_path/'m.json';m.write_text(json.dumps({'files':[{'path':'x','sha256':'0'}]}));assert verify(tmp_path,m)[0].startswith('MISSING')
def test_verify_hash(tmp_path):
 p=tmp_path/'x';p.write_text('x');m=tmp_path/'m.json';m.write_text(json.dumps({'files':[{'path':'x','sha256':'0'}]}));assert verify(tmp_path,m)[0].startswith('HASH')
