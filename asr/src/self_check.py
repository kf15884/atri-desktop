from pathlib import Path
import hashlib,json,sys
from importlib.metadata import version
root=Path(__file__).resolve().parent.parent
print('Atri Japanese ASR 0.1.0 | local CPU/int8 | Japanese only')
print('Python:',sys.version.split()[0])
for package in ['faster-whisper','ctranslate2','onnxruntime','av','numpy']:
    print(package,version(package))
import ctranslate2,numpy,onnxruntime,av
if 'int8' not in ctranslate2.get_supported_compute_types('cpu'):
    raise SystemExit('CPU int8 unsupported')
manifest=json.loads((root/'FILES-SHA256.json').read_text(encoding='utf-8'))
for name,expected in manifest.items():
    path=root/name
    if not path.is_file():raise SystemExit('Missing file: '+name)
    with path.open('rb') as f:actual=hashlib.file_digest(f,'sha256').hexdigest()
    if actual!=expected:raise SystemExit('Checksum mismatch: '+name)
print('Files verified. Runtime imports OK. This does not test Windows audio capture or recognition accuracy.')
