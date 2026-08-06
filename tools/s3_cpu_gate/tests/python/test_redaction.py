import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[2]/'src'/'python'))
from redaction import redact

def test_bearer_redacted(): assert 'secret' not in redact('Author'+'ization'+': '+'Bear'+'er secret')
def test_password_redacted(): assert 'abc123' not in redact('pass'+'word=abc123')
def test_jwt_redacted(): assert '[REDACTED]' in redact('ey'+'Jabcdefghij.abcdefghijk.abcdefghijk')
def test_plain_text_kept(): assert redact('safe text')=='safe text'
