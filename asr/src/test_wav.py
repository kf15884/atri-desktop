"""User-selected WAV only, sends to local service. Never captures audio itself."""
import argparse, json, urllib.request
from pathlib import Path
from server import decode_wav,MAX_BODY
p=argparse.ArgumentParser();p.add_argument('wav',type=Path);p.add_argument('--port',type=int,default=8000);a=p.parse_args()
if not 1024<=a.port<=65535: p.error('invalid port')
if a.wav.stat().st_size>MAX_BODY-1024:p.error('WAV too large')
data=a.wav.read_bytes();decode_wav(data)
boundary='AtriLocalWavTest0p1'
body=(f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nsmall\r\n'
      f'--{boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n'
      f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n').encode()+data+f'\r\n--{boundary}--\r\n'.encode()
request=urllib.request.Request(f'http://127.0.0.1:{a.port}/v1/audio/transcriptions',data=body,headers={'Content-Type':'multipart/form-data; boundary='+boundary})
# Ignore proxy environment for loopback requests.
with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request,timeout=150) as res:
 print(json.dumps(json.load(res),ensure_ascii=False,indent=2))
