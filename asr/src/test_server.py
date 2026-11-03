import contextlib, http.client, importlib.util, io, json, math, struct, threading, unittest, wave
from pathlib import Path
from types import SimpleNamespace
import server as s

def wav(samples=None,rate=16000,channels=1):
    buf=io.BytesIO()
    if samples is None: samples=[0]*16000
    with wave.open(buf,'wb') as f:
        f.setnchannels(channels);f.setsampwidth(2);f.setframerate(rate);f.writeframes(struct.pack('<'+'h'*len(samples),*samples))
    return buf.getvalue()
def form(audio,**fields):
    body=b'';boundary='AtriTestBoundary'
    for key,value in dict(model='small',response_format='verbose_json',**fields).items():
        body+=f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode()
    body+=f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()+audio+f'\r\n--{boundary}--\r\n'.encode()
    return 'multipart/form-data; boundary='+boundary,body
class FakeModel:
    def __init__(self,*a,**kw):self.kw=kw;self.calls=[]
    def transcribe(self,a,**kw):
        self.calls.append(kw)
        p=SimpleNamespace(text='こんにちは。',start=0,end=0.8,no_speech_prob=0.01,avg_logprob=-0.1)
        return iter([p]),SimpleNamespace(language='ja')
class Tests(unittest.TestCase):
    def test_form(self):
        ct,b=form(wav());self.assertEqual(s.parse_form(ct,b)['model'],'small')
    def test_language(self):
        ct,b=form(wav(),language='en')
        with self.assertRaises(s.BadRequest):s.parse_form(ct,b)
    def test_old_model_rejected(self):
        ct,b=form(wav());b=b.replace(b'\r\nsmall\r\n',b'\r\nSenseVoiceSmall\r\n')
        with self.assertRaises(s.BadRequest):s.parse_form(ct,b)
    def test_no_urls(self):
        ct,b=form(b'https://example.com/audio.wav');fields=s.parse_form(ct,b)
        with self.assertRaises(s.BadRequest):s.decode_wav(fields['file'])
    def test_bad_wav(self):
        for v in [b'',b'RIFF',wav(rate=8000),wav(channels=2),wav(samples=[0]*10),wav()[:-30]]:
            with self.assertRaises(s.BadRequest):s.decode_wav(v)
    def test_duration(self):
        raw,d=s.decode_wav(wav());self.assertEqual(d,1);self.assertEqual(len(raw),32000)
    def test_silence_and_forced_ja(self):
        r=s.Recognizer(Path('.'),model_factory=FakeModel)
        raw,d=s.decode_wav(wav());self.assertEqual(r.run(raw,d)['status'],'silence');self.assertFalse(r.model.calls)
        raw,d=s.decode_wav(wav([int(2000*math.sin(i/15)) for i in range(16000)]))
        result=r.run(raw,d);self.assertEqual(result['text'],'こんにちは。');self.assertEqual(r.model.calls[0]['language'],'ja')
        self.assertEqual(r.model.calls[0]['task'],'transcribe');self.assertEqual(r.model.kw['device'],'cpu')
    def test_http(self):
        r=s.Recognizer(Path('.'),model_factory=FakeModel)
        with s.LocalServer(('127.0.0.1',0),r) as server:
            th=threading.Thread(target=server.serve_forever,daemon=True);th.start();port=server.server_port
            def call(method,path,body=None,headers=None):
                conn=http.client.HTTPConnection('127.0.0.1',port,timeout=5);conn.request(method,path,body=body,headers=headers or {})
                res=conn.getresponse();data=json.loads(res.read());conn.close();return res.status,data
            self.assertTrue(call('GET','/health')[1]['ready'])
            self.assertEqual(call('GET','/health',headers={'Origin':'https://evil.example'})[0],403)
            self.assertEqual(call('GET','/health',headers={'Host':'evil.example'})[0],403)
            self.assertEqual(call('GET','/v1/models')[0],404)
            ct,body=form(wav());headers={'Content-Type':ct}
            code,data=call('POST','/v1/audio/transcriptions',body,headers);self.assertEqual(code,200);self.assertEqual(data['status'],'silence')
            r.busy.acquire()
            try:self.assertEqual(call('POST','/v1/audio/transcriptions',body,headers)[0],503)
            finally:r.busy.release()
            self.assertEqual(call('POST','/v1/audio/transcriptions',b'a',{'Content-Length':str(s.MAX_BODY+1)})[0],413)
            self.assertEqual(call('POST','/v1/audio/transcriptions',b'bad',headers)[0],400)
            server.shutdown();th.join()
if __name__=='__main__':unittest.main(verbosity=2)
