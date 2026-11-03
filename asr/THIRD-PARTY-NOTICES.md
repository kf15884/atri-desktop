# Third-party components

- CPython official Windows embeddable distribution: runtime/LICENSE.txt (PSF license and bundled notices).
- faster-whisper 1.2.1 by SYSTRAN: MIT; included dist-info license files under runtime/Lib/site-packages.
- Whisper small weights converted by Systran/faster-whisper-small, fixed revision 536b0662742c02347bc0e980a01041f333bce120: MIT, original OpenAI Whisper license in licenses/Whisper-MIT.txt. Model card and provenance in models/small.
- CTranslate2, ONNX Runtime, PyAV, NumPy, tokenizers and other dependencies: their original dist-info licenses/notices are retained. PyAV bundles FFmpeg libraries; retain included wheel notices.
- Complete Windows dependency filenames/hashes: DEPENDENCY-PROVENANCE.json. No wheels are rebuilt or binary-patched; files are extracted from official PyPI wheels, with paths adapted for the official embedded Python import search path.
- Public Japanese test sample: National Institute for Japanese Language and Linguistics, CSJ sample https://clrd.ninjal.ac.jp/csj/en/sample.html. Audio/reference were used for local QA only and are NOT redistributed in this package. This is not a claim of accuracy on anime dialogue.

The Atri companion service code is distributed under MIT; it is not an official release of these upstream projects.
