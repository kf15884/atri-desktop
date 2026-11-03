import json,urllib.request
url='http://127.0.0.1:8000/health'
try:
 with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(url,timeout=5) as r:
  data=json.load(r)
 if data.get('service')!='atri-japanese-asr' or data.get('model')!='small':raise ValueError('wrong service on port 8000')
 print(json.dumps(data,ensure_ascii=False,indent=2))
except Exception as e:
 raise SystemExit('ASR is not ready. Run start-asr.cmd first. '+str(e))
