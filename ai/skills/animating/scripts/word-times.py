import json
import subprocess
import sys
from pathlib import Path

import numpy
from faster_whisper import WhisperModel

WHISPER_SAMPLE_RATE = 16000


def decode_with_ffmpeg(clip_path):
    decode = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(clip_path), "-f", "f32le", "-ac", "1", "-ar", str(WHISPER_SAMPLE_RATE), "-"],
        capture_output=True,
    )
    if decode.returncode != 0:
        sys.exit(f"ffmpeg could not decode {clip_path}: {decode.stderr.decode().strip()}")
    return numpy.frombuffer(decode.stdout, dtype=numpy.float32)


def transcribe_words(model, clip_path):
    segments, _ = model.transcribe(decode_with_ffmpeg(clip_path), word_timestamps=True, beam_size=5)
    return [
        {"word": word.word.strip(), "start": round(word.start, 2), "end": round(word.end, 2)}
        for segment in segments
        for word in segment.words
    ]


def main(clip_paths):
    if not clip_paths:
        sys.exit("usage: word-times.py <clip.wav> [<clip.wav> ...]")
    model = WhisperModel("base.en", device="cpu", compute_type="int8")
    words_by_clip = {Path(clip_path).name: transcribe_words(model, clip_path) for clip_path in clip_paths}
    print(json.dumps(words_by_clip, indent=1))


main(sys.argv[1:])
