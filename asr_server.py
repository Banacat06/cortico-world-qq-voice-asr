#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cortico-world-qq-voice 的本地语音识别服务。

契约（和插件 src/asr.ts 对齐）：
  GET  /health                     -> {"ready": true, "engine": "sherpa-onnx", ...}
  POST /asr   (audio/wav 裸字节)    -> {"text": "..."}

只做一件事：把 WAV 交给 sherpa-onnx 的 SenseVoiceSmall，返回文字。
不做 TTS、不联网、不读部署密钥。

依赖（Coopanion 的 venv_vox 里已经装好）：
  pip install sherpa-onnx numpy

模型目录需要 tokens.txt 与 model_q8.onnx / model.onnx / model.int8.onnx 之一。
"""

import argparse
import io
import json
import os
import re
import sys
import threading
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

MAX_BODY = 32 * 1024 * 1024
ENGINE = None
MODEL_NAME = ""
READY = False


def pick_model(model_dir: str):
    for name in ("model_q8.onnx", "model.onnx", "model.int8.onnx"):
        path = os.path.join(model_dir, name)
        if os.path.isfile(path):
            return path
    raise ValueError(
        "模型目录里没有 model_q8.onnx / model.onnx / model.int8.onnx：%s" % model_dir
    )


def load_model(model_dir: str) -> None:
    global ENGINE, MODEL_NAME, READY
    if not model_dir or not os.path.isdir(model_dir):
        raise ValueError("模型目录不存在：%s" % model_dir)
    tokens = os.path.join(model_dir, "tokens.txt")
    if not os.path.isfile(tokens):
        raise ValueError("模型目录里没有 tokens.txt：%s" % model_dir)
    onnx = pick_model(model_dir)
    ENGINE = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=onnx,
        tokens=tokens,
        num_threads=2,
        language="auto",
        use_itn=True,
        provider="cpu",
    )
    MODEL_NAME = os.path.basename(onnx)
    READY = True


def read_wav(data: bytes) -> np.ndarray:
    """WAV -> 16k 单声道 float32 [-1,1]。NapCat 的 get_record 默认是 24k 单声道。"""
    if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("不是 WAV（需要 RIFF/WAVE）")
    with wave.open(io.BytesIO(data), "rb") as w:
        channels = w.getnchannels()
        width = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())
    if width != 2:
        raise ValueError("只支持 16-bit PCM WAV，当前 sampwidth=%d" % width)
    arr = np.frombuffer(frames, dtype="<i2").astype(np.float32)
    if channels > 1:
        arr = arr.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and arr.size:
        n = max(1, int(round(arr.size * 16000 / rate)))
        xs = np.linspace(0, arr.size - 1, n)
        arr = np.interp(xs, np.arange(arr.size), arr)
    return arr / 32768.0


def transcribe(data: bytes) -> str:
    arr = read_wav(data)
    stream = ENGINE.create_stream()
    stream.accept_waveform(16000, arr)
    ENGINE.decode_stream(stream)
    res = stream.result
    text = getattr(res, "text", None)
    if not text and isinstance(res, dict):
        text = res.get("text")
    # SenseVoice 会带 <|zh|> <|NEUTRAL|> 这类标签，去掉后再给模型。
    return re.sub(r"<\|[^|]*\|>", "", text or "").strip()


def parse_multipart(body: bytes, boundary: bytes) -> dict:
    parts = {}
    for part in body.split(b"--" + boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        head_end = part.find(b"\r\n\r\n")
        if head_end < 0:
            continue
        headers = part[:head_end].decode("utf-8", "ignore")
        content = part[head_end + 4:]
        if content.endswith(b"\r\n"):
            content = content[:-2]
        name = None
        for line in headers.split("\r\n"):
            if line.lower().startswith("content-disposition"):
                for kv in line.split(";"):
                    kv = kv.strip()
                    if kv.lower().startswith("name="):
                        name = kv[5:].strip().strip('"')
        if name:
            parts[name] = content
    return parts


class Handler(BaseHTTPRequestHandler):
    server_version = "qq-voice-asr/0.1"

    def _send(self, code: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/ready"):
            self._send(200, {
                "ready": READY,
                "engine": "sherpa-onnx",
                "model": MODEL_NAME,
                "state": "ok" if READY else "loading",
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path not in ("/asr", "/transcribe", "/v1/audio/transcriptions", "/"):
            self._send(404, {"error": "not found"})
            return
        if not READY:
            self._send(503, {"error": "model not ready"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            self._send(400, {"error": "bad content-length"})
            return
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"error": "empty or too large body"})
            return
        body = self.rfile.read(length)
        ctype = self.headers.get("Content-Type", "")
        audio = body
        if "multipart/form-data" in ctype:
            boundary = ctype.split("boundary=", 1)[-1].strip().strip('"').encode("utf-8")
            audio = parse_multipart(body, boundary).get("file", b"")
            if not audio:
                self._send(400, {"error": "missing file field"})
                return
        try:
            text = transcribe(audio)
            self._send(200, {"text": text})
        except Exception as e:  # noqa: BLE001 - 交给调用方显示，不吞
            self._send(500, {"error": str(e), "trace": traceback.format_exc()[-1200:]})

    def log_message(self, fmt, *args):
        sys.stderr.write("[asr] " + (fmt % args) + "\n")
        sys.stderr.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8779)
    ap.add_argument("--model-dir", required=True)
    args = ap.parse_args()

    sys.stdout.write("ASR_SERVER_LOADING model_dir=%s port=%d\n" % (args.model_dir, args.port))
    sys.stdout.flush()
    try:
        load_model(args.model_dir)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("ASR_SERVER_LOAD_FAIL: %s\n" % e)
        sys.stderr.write(traceback.format_exc())
        sys.stderr.flush()
        return 2

    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.daemon_threads = True
    sys.stdout.write("ASR_SERVER_READY port=%d model=%s\n" % (args.port, MODEL_NAME))
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
