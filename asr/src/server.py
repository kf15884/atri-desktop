"""Atri Japanese ASR 0.1.0. Local WAV -> Japanese text, no audio disk writes."""
from __future__ import annotations
import argparse, io, json, math, socket, threading, time, wave
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = '0.1.0'
MAX_BODY = 4 * 1024 * 1024
MODEL_ID = 'small'

class BadRequest(ValueError):
    pass

def parse_form(content_type, body):
    if not content_type.lower().startswith('multipart/form-data;'):
        raise BadRequest('multipart/form-data required')
    if len(body) > MAX_BODY or len(content_type) > 512 or '\r' in content_type or '\n' in content_type:
        raise BadRequest('request too large or invalid header')
    msg = BytesParser(policy=default).parsebytes(('Content-Type: '+content_type+'\r\nMIME-Version: 1.0\r\n\r\n').encode('ascii') + body)
    if not msg.is_multipart():
        raise BadRequest('invalid multipart')
    fields = {}
    for part in msg.iter_parts():
        name = part.get_param('name', header='content-disposition')
        if name not in {'file','model','response_format','language','temperature'} or name in fields or part.is_multipart():
            raise BadRequest('unsupported or repeated field')
        value = part.get_payload(decode=True)
        if value is None:
            raise BadRequest('invalid field')
        if name != 'file':
            if len(value) > 128: raise BadRequest('field too large')
            value = value.decode('utf-8', errors='strict')
        fields[name] = value
    if fields.get('model') != MODEL_ID:
        raise BadRequest('model must be small; do not use SenseVoiceSmall')
    if fields.get('language', 'ja') != 'ja':
        raise BadRequest('this service only supports language=ja')
    if fields.get('response_format', 'verbose_json') not in {'json','verbose_json'}:
        raise BadRequest('json or verbose_json required')
    if not isinstance(fields.get('file'), bytes): raise BadRequest('WAV file required')
    return fields

def decode_wav(data):
    # Deliberately accepts only the desktop bridge's PCM format, not URLs/files/codecs.
    try:
        with wave.open(io.BytesIO(data), 'rb') as wav:
            if (wav.getnchannels(), wav.getsampwidth(), wav.getframerate(), wav.getcomptype()) != (1,2,16000,'NONE'):
                raise BadRequest('use mono 16000 Hz PCM16 WAV')
            frames = wav.getnframes()
            if not 1600 <= frames <= 16000*120: raise BadRequest('WAV duration must be 0.1 to 120 seconds')
            raw = wav.readframes(frames)
            if len(raw) != frames*2: raise BadRequest('truncated WAV')
            return raw, frames/16000
    except (wave.Error, EOFError) as exc:
        raise BadRequest('invalid PCM WAV') from exc

class Recognizer:
    def __init__(self, model_dir, threads=6, model_factory=None):
        if model_factory is None:
            from faster_whisper import WhisperModel
            model_factory = WhisperModel
        self.model = model_factory(str(model_dir), device='cpu', compute_type='int8', cpu_threads=threads, num_workers=1, local_files_only=True)
        self.busy = threading.Lock()

    def run(self, raw, duration):
        import numpy as np
        audio = np.frombuffer(raw, dtype='<i2').astype(np.float32)/32768.0
        # Exact/near silence: don't ask Whisper to hallucinate a closing phrase.
        if float(np.sqrt(np.mean(audio*audio))) < 0.0001:
            return dict(text='', segments=[], language='ja', duration=duration, status='silence', model=MODEL_ID)
        started = time.monotonic()
        parts, info = self.model.transcribe(audio, language='ja', task='transcribe', beam_size=3,
            vad_filter=True, vad_parameters={'min_silence_duration_ms':500, 'speech_pad_ms':200},
            condition_on_previous_text=False, temperature=0.0, word_timestamps=False,
            no_speech_threshold=0.6, log_prob_threshold=-1.0, compression_ratio_threshold=2.4)
        segments, total = [], 0
        for part in parts:
            text = str(part.text).strip()
            start, end = float(part.start), float(part.end)
            if not text or not math.isfinite(start) or not math.isfinite(end): continue
            if part.no_speech_prob > 0.6 and part.avg_logprob < -1.0: continue
            start, end = max(0.0,start), min(duration,end)
            if end < start: continue
            # Drop only adjacent identical overlapping segments; repeated spoken phrases remain.
            if segments and text == segments[-1]['text'] and start < segments[-1]['end']: continue
            text = text[:max(0,2400-total)]
            if not text: break
            segments.append(dict(start=round(start,3),end=round(end,3),text=text))
            total += len(text)
            if len(segments) >= 100 or total >= 2400: break
        return dict(text=''.join(s['text'] for s in segments), segments=segments, language='ja',
                    duration=duration, status='speech' if segments else 'no_speech', model=MODEL_ID,
                    processing_seconds=round(time.monotonic()-started,3))

class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 4
    def __init__(self, address, recognizer):
        self.recognizer = recognizer
        self.slots = threading.BoundedSemaphore(4)
        super().__init__(address, Handler)
    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close(); return
        try: super().process_request(request, client_address)
        except BaseException:
            self.slots.release(); raise
    def process_request_thread(self, request, client_address):
        try: super().process_request_thread(request, client_address)
        finally: self.slots.release()

class Handler(BaseHTTPRequestHandler):
    server_version = 'AtriJapaneseASR/'+VERSION
    def setup(self):
        super().setup(); self.connection.settimeout(10)
    def log_message(self, *args): pass  # No payload, text, title, paths or access log.
    def safe_request(self):
        expected = f'127.0.0.1:{self.server.server_port}'
        return (self.client_address[0] == '127.0.0.1' and self.headers.get('Host') == expected
                and not self.headers.get('Origin') and not self.headers.get('Transfer-Encoding'))
    def send_json(self, status, data):
        payload = json.dumps(data, ensure_ascii=False, allow_nan=False).encode('utf-8')
        self.close_connection = True
        try:
            self.send_response(status); self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(payload))); self.send_header('Cache-Control','no-store')
            self.send_header('Connection','close'); self.end_headers(); self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, socket.timeout): pass
    def do_GET(self):
        if not self.safe_request(): return self.send_json(403, {'error':'local main-process requests only'})
        if self.path != '/health': return self.send_json(404, {'error':'not found'})
        return self.send_json(200,dict(service='atri-japanese-asr',version=VERSION,model=MODEL_ID,language='ja',
                      device='cpu',compute_type='int8',ready=True,busy=self.server.recognizer.busy.locked()))
    def do_POST(self):
        if not self.safe_request(): return self.send_json(403,{'error':'local main-process requests only'})
        if self.path != '/v1/audio/transcriptions': return self.send_json(404,{'error':'not found'})
        if not self.server.recognizer.busy.acquire(blocking=False): return self.send_json(503,{'error':'ASR busy; no request queued'})
        try:
            lengths=self.headers.get_all('Content-Length',[])
            if len(lengths) != 1 or not lengths[0].isdigit(): raise BadRequest('one Content-Length required')
            size=int(lengths[0])
            if not 1 <= size <= MAX_BODY: return self.send_json(413,{'error':'WAV request too large'})
            body=self.rfile.read(size)
            if len(body) != size: raise BadRequest('incomplete request')
            fields=parse_form(self.headers.get('Content-Type',''),body)
            raw,duration=decode_wav(fields.pop('file'))
            body=None; fields=None
            result=self.server.recognizer.run(raw,duration)
            self.send_json(200,result)
        except (BadRequest, UnicodeError, ValueError): self.send_json(400,{'error':'Invalid request: use model=small, language=ja and mono 16k PCM16 WAV (0.1-120s)'})
        except socket.timeout: self.send_json(408,{'error':'request read timeout'})
        except Exception: self.send_json(500,{'error':'Local ASR failed; check runtime/model files; no cloud fallback'})
        finally:
            self.server.recognizer.busy.release()
    def do_OPTIONS(self): self.send_json(403,{'error':'browser access disabled'})

def main():
    parser=argparse.ArgumentParser(description='CPU-only Japanese transcription, loopback only')
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--threads',type=int,default=6)
    args=parser.parse_args()
    if not 1024 <= args.port <= 65535 or not 1 <= args.threads <= 16: parser.error('invalid port or threads')
    for file in ['model.bin','config.json','tokenizer.json','vocabulary.txt']:
        if not (args.model_dir/file).is_file(): parser.error('model files missing; run download-model first')
    print('Loading local small model on CPU/int8; no audio is recorded until the desktop starts capture.',flush=True)
    recognizer=Recognizer(args.model_dir,args.threads)
    try: server=LocalServer(('127.0.0.1',args.port),recognizer)
    except OSError:
        print('Port unavailable. Stop the old ASR service; do not kill unrelated processes.',flush=True); return 1
    print(f'Ready: http://127.0.0.1:{args.port}/v1 | model=small | Japanese transcription (not translation). Ctrl+C stops.',flush=True)
    try: server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt: pass
    finally: server.server_close()
    return 0
if __name__ == '__main__': raise SystemExit(main())
