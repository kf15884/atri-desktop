"""Explicit download step only; server never contacts Hugging Face."""
from pathlib import Path
import argparse, hashlib, json, os
REPO='Systran/faster-whisper-small'
REVISION='536b0662742c02347bc0e980a01041f333bce120'
FILES=['config.json','model.bin','tokenizer.json','vocabulary.txt']
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--dest',type=Path,required=True);args=parser.parse_args()
    provenance=args.dest/'MODEL-PROVENANCE.json'
    if provenance.is_file():
        info=json.loads(provenance.read_text(encoding='utf-8'))
        if info.get('revision')==REVISION and all((args.dest/n).is_file() and hashlib.file_digest(open(args.dest/n,'rb'),'sha256').hexdigest()==info.get('files',{}).get(n) for n in FILES):
            print('Existing model verified. No download needed.',flush=True); return
    from huggingface_hub import hf_hub_download
    args.dest.mkdir(parents=True,exist_ok=True)
    for name in FILES:
        print('Download/verify:',name,flush=True)
        hf_hub_download(REPO,name,revision=REVISION,local_dir=args.dest)
    info={'repo':REPO,'revision':REVISION,'files':{n:hashlib.sha256((args.dest/n).read_bytes()).hexdigest() for n in FILES}}
    (args.dest/'MODEL-PROVENANCE.json').write_text(json.dumps(info,indent=2),encoding='utf-8')
    print('Model ready. Server is offline-only.',flush=True)
if __name__=='__main__': main()
