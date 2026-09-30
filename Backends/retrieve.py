from __future__ import annotations

import argparse
import json
import os
import re
import sys
import random
import time
import urllib.request  # 用于处理本地文件路径为 file:// URI
from collections import defaultdict
from pathlib import Path
from typing import Optional, Dict, Any, Tuple
import hashlib
import chromadb
from dotenv import load_dotenv
import numpy as np
from chromadb.config import Settings

# --- 引入 Dashscope 及 ASR 模块 ---
import dashscope
from http import HTTPStatus
from dashscope.audio.asr import Transcription
from dashscope.embeddings import TextEmbedding
from dashscope.files import Files
from dashscope.utils.oss_utils import OssUtils

from openai import OpenAI
from langchain_chroma import Chroma
from langchain_core.documents import Document

from json_repair import repair_json
import subprocess
import tempfile
import base64
import requests

# ===========================================================================
# 路径与配置项
# ===========================================================================

MODULE_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = MODULE_DIR.parent if MODULE_DIR.name.lower() == "src" else MODULE_DIR

for _env_path in (MODULE_DIR / ".env", PROJECT_ROOT / ".env"):
    if _env_path.exists():
        load_dotenv(_env_path, override=False)


def _candidate_roots() -> list[Path]:
    roots = [
        MODULE_DIR,
        MODULE_DIR.parent,
        MODULE_DIR / "Backends",
        MODULE_DIR.parent / "Backends",
    ]
    return list(dict.fromkeys(root for root in roots if root.exists()))


def _find_vectors_dir() -> Path:
    candidates = []
    for root in _candidate_roots():
        candidates.extend(
            [
                root / "data" / "Vectors",
                root / "Vectors",
            ]
        )

    for candidate in candidates:
        if (candidate / "content_chroma").is_dir() and (
            candidate / "fluency_chroma"
        ).is_dir():
            print(f"[Path] vector_dir={candidate}")
            return candidate

    fallback = candidates[0] if candidates else PROJECT_ROOT / "data" / "Vectors"
    print(
        "[Path][WARN] vector database was not found in candidates; "
        f"using fallback={fallback}"
    )
    return fallback


VECTORS_DIR = _find_vectors_dir()
DATA_DIR = VECTORS_DIR.parent

criteria_candidates = [
    root / "criteria.txt"
    for root in _candidate_roots()
]
CRITERIA_PATH = next(
    (candidate for candidate in criteria_candidates if candidate.exists()),
    DATA_DIR / "criteria.txt",
)
CONTENT_VECTOR_DIR = VECTORS_DIR / "content_chroma"
FLUENCY_VECTOR_DIR = VECTORS_DIR / "fluency_chroma"

INPUT_AUDIO_DIR = next(
    (
        root / "Audio_preprocessed"
        for root in _candidate_roots()
        if (root / "Audio_preprocessed").is_dir()
    ),
    PROJECT_ROOT / "Audio_preprocessed",
)
OUTPUT_PATH = PROJECT_ROOT

print(
    "[Path] "
    f"module_dir={MODULE_DIR}, "
    f"project_root={PROJECT_ROOT}, "
    f"vectors_dir={VECTORS_DIR}, "
    f"content_exists={CONTENT_VECTOR_DIR.is_dir()}, "
    f"fluency_exists={FLUENCY_VECTOR_DIR.is_dir()}, "
    f"criteria_path={CRITERIA_PATH}"
)

# 【已移除 WHISPER_MODEL_PATH】
ASR_MODEL = os.getenv("DASHSCOPE_ASR_MODEL", "qwen-audio-3.0-asr-flash-filetrans")
ASR_LANGUAGE_HINTS = [
    item.strip()
    for item in os.getenv("DASHSCOPE_ASR_LANGUAGE_HINTS", "en").split(",")
    if item.strip()
]
ASR_SENTENCE_GAP_MS = int(os.getenv("DASHSCOPE_ASR_SENTENCE_GAP_MS", "1500"))

PAUSE_THRESHOLD_MS = 100
MIN_PAUSE_MS = 100

FLUENCY_DIM_NAMES = [
    "speaking_rate_wpm",
    "mid_pause_100_200",
    "mid_pause_200_500",
    "mid_pause_gt_500",
    "filler_pause_100_250",
    "filler_pause_gt_250",
]

FEATURE_MIN = np.array([82.4, 0.0, 0.0, 2.0, 0.0, 0.0], dtype=float)
FEATURE_MAX = np.array([200.9, 12.0, 18.0, 65.0, 27.0, 11.0], dtype=float)

def normalize_fluency_features(raw_features: list[float]) -> list[float]:
    """将 6 维原始流畅度特征缩放到 [0, 1] 区间。"""
    arr = np.array(raw_features, dtype=float)
    scaled = (arr - FEATURE_MIN) / (FEATURE_MAX - FEATURE_MIN + 1e-8)
    scaled = np.clip(scaled, 0.0, 1.0)
    return scaled.tolist()


def ensure_normalized_fluency_features(features: dict) -> dict:
    """补齐 raw_values / normalized_values，并确保 values 使用归一化后的 6 维向量。"""
    result = dict(features or {})
    raw_values = result.get("raw_values")
    if not isinstance(raw_values, list) or len(raw_values) != len(FLUENCY_DIM_NAMES):
        raw_values = [float(result.get(dim, 0.0) or 0.0) for dim in FLUENCY_DIM_NAMES]
    else:
        raw_values = [float(v) for v in raw_values]

    normalized_values = result.get("normalized_values")
    if not isinstance(normalized_values, list) or len(normalized_values) != len(FLUENCY_DIM_NAMES):
        normalized_values = normalize_fluency_features(raw_values)
    else:
        normalized_values = [float(v) for v in normalized_values]

    result["raw_values"] = raw_values
    result["normalized_values"] = normalized_values
    result["values"] = normalized_values
    result["dim_names"] = FLUENCY_DIM_NAMES.copy()
    for dim, raw_value in zip(FLUENCY_DIM_NAMES, raw_values):
        result[dim] = raw_value
    return result


# ========== API Keys and DashScope endpoints ==========
DASHSCOPE_API_KEY = (os.getenv("DASHSCOPE_API_KEY") or "").strip() or None
DEEPSEEK_API_KEY = (os.getenv("DEEPSEEK_API_KEY") or "").strip() or DASHSCOPE_API_KEY
OFFICIAL_DEEPSEEK_MODEL = "deepseek-v4-pro-0813"
configured_deepseek_model = os.getenv("DEEPSEEK_MODEL", "").strip()
if configured_deepseek_model and configured_deepseek_model != OFFICIAL_DEEPSEEK_MODEL:
    print(
        "[DeepSeek][Config][WARN] unsupported model override "
        f"{configured_deepseek_model!r}; using {OFFICIAL_DEEPSEEK_MODEL}.",
        flush=True,
    )
DEEPSEEK_MODEL = OFFICIAL_DEEPSEEK_MODEL


def _configure_dashscope_runtime() -> dict[str, str | None]:
    region = os.getenv("DASHSCOPE_REGION", "beijing").strip().lower()
    workspace = os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip() or None

    region_hosts = {
        "beijing": (
            "dashscope.aliyuncs.com",
            "cn-beijing.maas.aliyuncs.com",
        ),
        "bj": (
            "dashscope.aliyuncs.com",
            "cn-beijing.maas.aliyuncs.com",
        ),
        "cn-beijing": (
            "dashscope.aliyuncs.com",
            "cn-beijing.maas.aliyuncs.com",
        ),
        
        "singapore": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
        "sg": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
    }
    region_config = region_hosts.get(region)
    if not region_config:
        raise RuntimeError(
            f"Unsupported DASHSCOPE_REGION={region!r}; "
            "use singapore or beijing."
        )

    public_host, workspace_suffix = region_config
    endpoint_host = (
        f"{workspace}.{workspace_suffix}" if workspace else public_host
    )

    http_url = (
        os.getenv("DASHSCOPE_BASE_HTTP_API_URL", "").strip()
        or os.getenv("DASHSCOPE_HTTP_BASE_URL", "").strip()
        or f"https://{endpoint_host}/api/v1"
    ).rstrip("/")
    websocket_url = (
        os.getenv("DASHSCOPE_BASE_WEBSOCKET_API_URL", "").strip()
        or os.getenv("DASHSCOPE_WEBSOCKET_BASE_URL", "").strip()
        or f"wss://{endpoint_host}/api-ws/v1/inference"
    ).rstrip("/")
    compatible_url = (
        os.getenv("DASHSCOPE_COMPATIBLE_BASE_URL", "").strip()
        or f"https://{endpoint_host}/compatible-mode/v1"
    ).rstrip("/")

    dashscope.api_key = DASHSCOPE_API_KEY
    dashscope.base_http_api_url = http_url
    dashscope.base_websocket_api_url = websocket_url
    dashscope.base_compatible_api_url = compatible_url

    print(
        "[DashScope] "
        f"region={region}, "
        f"http={http_url}, "
        f"compatible={compatible_url}, "
        f"workspace={'configured' if workspace else 'default'}, "
        f"api_key={'configured' if DASHSCOPE_API_KEY else 'missing'}"
    )

    return {
        "region": region,
        "workspace": workspace,
        "http_url": http_url,
        "websocket_url": websocket_url,
        "compatible_url": compatible_url,
    }


DASHSCOPE_RUNTIME = _configure_dashscope_runtime()
DASHSCOPE_WORKSPACE_ID = DASHSCOPE_RUNTIME["workspace"]
DASHSCOPE_BASE_URL = str(DASHSCOPE_RUNTIME["http_url"])
DASHSCOPE_COMPATIBLE_BASE_URL = str(DASHSCOPE_RUNTIME["compatible_url"])

FILLER_WORDS = {
    "uh", "uhh", "um", "umm", "uhm", "er", "err", 
    "ah", "ahh", "eh", "emm", "em", "mm", "mmm", 
    "hmm", "hm", "like"
}

deepseek_client = OpenAI(
    api_key=DEEPSEEK_API_KEY,
    base_url=DASHSCOPE_COMPATIBLE_BASE_URL,
)

# ===========================================================================
# 1. 处理考生音频 (由 Whisper 替换为 Paraformer-v2)
# ===========================================================================

def _response_field(value: Any, key: str) -> Any:
    if isinstance(value, dict):
        return value.get(key)
    return getattr(value, key, None)


def _extract_file_url(value: Any) -> str | None:
    if not value:
        return None

    for key in ("file_url", "url", "download_url", "signed_url", "oss_url"):
        field_value = _response_field(value, key)
        if field_value:
            return str(field_value)

    for key in ("output", "data", "file"):
        nested = _response_field(value, key)
        if nested and nested is not value:
            nested_url = _extract_file_url(nested)
            if nested_url:
                return nested_url

    return None


def _extract_uploaded_file_id(upload_response: Any) -> str | None:
    output = _response_field(upload_response, "output") or upload_response
    file_id = _response_field(output, "file_id") or _response_field(output, "id")
    if file_id:
        return str(file_id)

    uploaded_files = _response_field(output, "uploaded_files") or []
    if isinstance(uploaded_files, list):
        for uploaded_file in uploaded_files:
            file_id = (
                _response_field(uploaded_file, "file_id")
                or _response_field(uploaded_file, "id")
            )
            if file_id:
                return str(file_id)

    return None


def _resolve_files_upload_url(upload_response: Any) -> str | None:
    file_url = _extract_file_url(upload_response)
    if file_url:
        return file_url

    file_id = _extract_uploaded_file_id(upload_response)
    if not file_id:
        return None

    print(f"    [API 上传] 已获得 file_id={file_id}，正在查询文件详情...")
    file_response = Files.get(file_id=file_id, api_key=DASHSCOPE_API_KEY)
    if file_response.status_code != HTTPStatus.OK:
        print(f"❌ 获取文件详情失败: {file_response.message}")
        return None

    return _extract_file_url(file_response)



def get_ffmpeg_path() -> str | None:
    """自动获取可用 FFmpeg 执行路径（优先检测 imageio-ffmpeg）"""
    # 1. 尝试调用 imageio-ffmpeg 提供的二进制文件
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        pass

    # 2. 检查系统环境变量中的 ffmpeg
    try:
        subprocess.run(["ffmpeg", "-version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        return "ffmpeg"
    except Exception:
        pass

    return None


def convert_audio_with_ffmpeg(input_path: Path) -> Path:
    """
    强制转码为 DashScope 标准格式：16kHz / 单声道 / 16-bit PCM WAV
    """
    temp_dir = Path(tempfile.gettempdir()) / "dashscope_audio_prep"
    temp_dir.mkdir(parents=True, exist_ok=True)
    target_path = temp_dir / f"{input_path.stem}_ffmpeg_16k.wav"

    ffmpeg_bin = get_ffmpeg_path()
    if not ffmpeg_bin:
        print("❌ 未找到可用 FFmpeg，请先下载ffmpeg！")
        return input_path

    cmd = [
        ffmpeg_bin,
        "-y",                       # 覆盖同名临时文件
        "-i", str(input_path),      # 输入源音频
        "-ar", "16000",             # 强制 16kHz
        "-ac", "1",                 # 强制单声道
        "-c:a", "pcm_s16le",        # 强制标准 PCM 编码
        str(target_path)
    ]

    try:
        subprocess.run(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE, 
            text=True, 
            check=True
        )
        file_size_kb = target_path.stat().st_size / 1024
        print(f"    [FFmpeg 预处理成功] 生成文件: {target_path.name} ({file_size_kb:.2f} KB)")
        return target_path
    except Exception as e:
        print(f"⚠️ FFmpeg 转码失败: {e}")
        return input_path


ASR_TRAILING_PUNCTUATION = ",.;:?!，。！？；："
ASR_TERMINAL_PUNCTUATION = ".?!。！？"

ASR_COMMON_CAPITALIZATION = {
    "ielts": "IELTS",
    "english": "English",
    "china": "China",
    "chinese": "Chinese",
    "britain": "Britain",
    "british": "British",
    "america": "America",
    "american": "American",
}

ASR_I_FORMS = {
    "i": "I",
    "i'm": "I'm",
    "im": "I'm",
    "i've": "I've",
    "ive": "I've",
    "i'll": "I'll",
    "ill": "I'll",
    "i'd": "I'd",
    "id": "I'd",
}


def _first_present(mapping: dict, keys: tuple[str, ...]) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None and value != "":
            return value
    return None


def _iter_transcripts(transcription_data: Any):
    if not isinstance(transcription_data, dict):
        return

    transcripts = transcription_data.get("transcripts")
    if isinstance(transcripts, list):
        for transcript in transcripts:
            if isinstance(transcript, dict):
                yield transcript
        return

    for key in ("result", "output", "data"):
        nested = transcription_data.get(key)
        if isinstance(nested, dict) and nested is not transcription_data:
            yield from _iter_transcripts(nested)
            return

    if isinstance(transcription_data.get("sentences"), list) or isinstance(
        transcription_data.get("words"), list
    ):
        yield transcription_data


def _sentence_items_from_transcript(transcript: dict) -> list[dict]:
    sentences = transcript.get("sentences")
    if isinstance(sentences, list) and sentences:
        return [sentence for sentence in sentences if isinstance(sentence, dict)]

    words = transcript.get("words")
    if isinstance(words, list) and words:
        return [
            {
                "text": transcript.get("text", ""),
                "words": words,
                "begin_time": transcript.get("begin_time"),
                "end_time": transcript.get("end_time"),
            }
        ]

    return []


def _numeric_time_values(sentence_items: list[dict]) -> list[float]:
    values = []
    for sentence in sentence_items:
        for key in ("begin_time", "end_time", "start_time", "stop_time", "start", "end"):
            value = sentence.get(key)
            if value is None or value == "":
                continue
            try:
                values.append(float(value))
            except (TypeError, ValueError):
                pass

        words = sentence.get("words") or []
        if not isinstance(words, list):
            continue
        for word in words:
            if not isinstance(word, dict):
                continue
            for key in (
                "begin_time",
                "end_time",
                "start_time",
                "stop_time",
                "start",
                "end",
            ):
                value = word.get(key)
                if value is None or value == "":
                    continue
                try:
                    values.append(float(value))
                except (TypeError, ValueError):
                    pass
    return values


def _infer_times_are_milliseconds(time_values: list[float]) -> bool:
    if not time_values:
        return True

    max_value = max(time_values)
    if max_value > 1000:
        return True

    all_integer_like = all(float(value).is_integer() for value in time_values)
    return all_integer_like and max_value > 30


def _time_to_seconds(value: Any, times_are_ms: bool) -> float | None:
    if value is None or value == "":
        return None
    try:
        numeric = float(value)
    except (TypeError, ValueError):
        return None

    if times_are_ms:
        return numeric / 1000.0
    if numeric > 1000:
        return numeric / 1000.0
    return numeric


def _split_word_and_punctuation(raw_text: Any, raw_punctuation: Any) -> tuple[str, str]:
    word = str(raw_text or "").strip()
    punctuation = str(raw_punctuation or "").strip()

    if punctuation and word.endswith(punctuation):
        word = word[: -len(punctuation)].rstrip()

    match = re.match(r"^(.*?)([,.;:?!，。！？；：]+)$", word)
    if match:
        word = match.group(1).strip()
        if not punctuation:
            punctuation = match.group(2)

    return word, punctuation


def _restore_word_case(word: str, sentence_start: bool) -> str:
    if not word:
        return word

    lower_word = word.lower()
    if lower_word in ASR_I_FORMS:
        return ASR_I_FORMS[lower_word]
    if lower_word in ASR_COMMON_CAPITALIZATION:
        return ASR_COMMON_CAPITALIZATION[lower_word]

    if any(char.isupper() for char in word):
        return word

    if sentence_start:
        match = re.match(r"^([^A-Za-z]*)([A-Za-z])(.*)$", word)
        if match:
            return f"{match.group(1)}{match.group(2).upper()}{match.group(3)}"

    return word


def _format_word_text(base_text: str, punctuation: str, sentence_start: bool) -> str:
    return f"{_restore_word_case(base_text, sentence_start)}{punctuation}"


def _has_terminal_punctuation(word: dict) -> bool:
    punctuation = str(word.get("punctuation") or "")
    text = str(word.get("text") or "")
    return bool(
        punctuation.endswith(tuple(ASR_TERMINAL_PUNCTUATION))
        or text.endswith(tuple(ASR_TERMINAL_PUNCTUATION))
    )


def _ensure_terminal_word_text(text: str) -> str:
    stripped = text.rstrip()
    if not stripped or stripped.endswith(tuple(ASR_TERMINAL_PUNCTUATION)):
        return text
    if stripped.endswith(tuple(",;:，；：")):
        stripped = stripped[:-1]
    return f"{stripped}."


def _join_sentence_words(words: list[dict]) -> str:
    text = " ".join(str(word.get("text", "")).strip() for word in words if word.get("text"))
    text = re.sub(r"\s+([,.;:?!，。！？；：])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


def _finalize_word_sentence(words: list[dict], force_terminal: bool) -> dict | None:
    formatted_words = []
    for index, word in enumerate(words):
        base_text = str(word.get("base_text") or "").strip()
        if not base_text:
            continue
        punctuation = str(word.get("punctuation") or "")
        formatted_word = dict(word)
        formatted_word["text"] = _format_word_text(
            base_text,
            punctuation,
            sentence_start=(index == 0),
        )
        formatted_words.append(formatted_word)

    if not formatted_words:
        return None

    if force_terminal and not _has_terminal_punctuation(formatted_words[-1]):
        formatted_words[-1]["text"] = _ensure_terminal_word_text(
            str(formatted_words[-1].get("text") or "")
        )
        formatted_words[-1]["punctuation"] = formatted_words[-1]["text"][-1]

    sentence_text = _join_sentence_words(formatted_words)
    if not sentence_text:
        return None

    return {"sentence_text": sentence_text, "words": formatted_words}


def _extract_word_records(sentence_items: list[dict], times_are_ms: bool) -> list[dict]:
    records = []
    for sentence in sentence_items:
        words = sentence.get("words") or []
        if not isinstance(words, list):
            continue

        for word in words:
            if not isinstance(word, dict):
                continue

            raw_text = _first_present(word, ("text", "word", "token"))
            raw_punctuation = _first_present(word, ("punctuation", "punct"))
            base_text, punctuation = _split_word_and_punctuation(raw_text, raw_punctuation)
            if not base_text:
                continue

            begin = _time_to_seconds(
                _first_present(word, ("begin_time", "start_time", "start", "begin")),
                times_are_ms,
            )
            end = _time_to_seconds(
                _first_present(word, ("end_time", "stop_time", "end", "finish")),
                times_are_ms,
            )
            if begin is None or end is None:
                continue

            records.append(
                {
                    "base_text": base_text,
                    "text": f"{base_text}{punctuation}",
                    "punctuation": punctuation,
                    "start": begin,
                    "end": end,
                }
            )

    records.sort(key=lambda item: (item["start"], item["end"]))
    return records


def _build_sentences_from_words(word_records: list[dict]) -> list[dict]:
    sentences = []
    current_words = []

    for word in word_records:
        if current_words:
            gap_ms = (word["start"] - current_words[-1]["end"]) * 1000
            if gap_ms >= ASR_SENTENCE_GAP_MS:
                sentence = _finalize_word_sentence(current_words, force_terminal=True)
                if sentence:
                    sentences.append(sentence)
                current_words = []

        current_words.append(word)

        if _has_terminal_punctuation(word):
            sentence = _finalize_word_sentence(current_words, force_terminal=False)
            if sentence:
                sentences.append(sentence)
            current_words = []

    if current_words:
        sentence = _finalize_word_sentence(current_words, force_terminal=True)
        if sentence:
            sentences.append(sentence)

    return sentences


def _format_fallback_sentence_text(text: str) -> str:
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    if not text:
        return ""

    words = text.split(" ")
    words = [_restore_word_case(word, sentence_start=(index == 0)) for index, word in enumerate(words)]
    text = " ".join(words)
    return _ensure_terminal_word_text(text)


def _build_fallback_sentences(text_parts: list[str]) -> list[dict]:
    sentences = []
    for text in text_parts:
        for chunk in re.split(r"(?<=[.!?。！？])\s+", text):
            formatted = _format_fallback_sentence_text(chunk)
            if formatted:
                sentences.append({"sentence_text": formatted, "words": []})
    return sentences


def _parse_asr_transcription_result(transcription_data: dict) -> tuple[str, list[dict]]:
    sentence_items = []
    fallback_text_parts = []

    for transcript in _iter_transcripts(transcription_data) or []:
        transcript_text = str(transcript.get("text") or "").strip()
        items = _sentence_items_from_transcript(transcript)
        if not items and transcript_text:
            fallback_text_parts.append(transcript_text)
            continue

        for item in items:
            sentence_items.append(item)
            sentence_text = str(item.get("text") or "").strip()
            if sentence_text:
                fallback_text_parts.append(sentence_text)

    times_are_ms = _infer_times_are_milliseconds(_numeric_time_values(sentence_items))
    word_records = _extract_word_records(sentence_items, times_are_ms)

    if word_records:
        all_sentences = _build_sentences_from_words(word_records)
    else:
        all_sentences = _build_fallback_sentences(fallback_text_parts)

    full_text = " ".join(sentence["sentence_text"] for sentence in all_sentences)
    return full_text.strip(), all_sentences


def transcribe_and_split_sentences(
    audio_path: str | Path,
) -> Tuple[str, list]:
    """使用当前配置的 DashScope ASR 模型进行异步转录。

    1. 上传音频文件获取 URL。 2. 提交异步转录任务。 3. 轮询获取结果并解析词级别时间戳。
    """
    abs_path = Path(audio_path).resolve()
    if not abs_path.exists():
        print(f"❌ 找不到音频文件: {abs_path}")
        return "", []

    # 1. 上传音频文件，获取可访问的 URL
    try:
        print(" [API 上传] 正在使用 OssUtils 上传文件...")
        file_url, _ = OssUtils.upload(
            model=ASR_MODEL,
            file_path=str(abs_path),
            api_key=DASHSCOPE_API_KEY,
        )
        print(f" [API 上传成功] 获取到文件链接: {file_url}")
    except Exception as exc:
        print(f"❌ 文件上传失败: OssUtils.upload 出现异常。错误信息: {exc}")
        return "", []

    # ==================== 🛠️ URL 校验（仅支持 http/https） ====================
    if file_url.startswith(("http://", "https://")):
        print(f"🔍 [DEBUG] 正在校验 HTTP/HTTPS URL 可达性: {file_url}")
        try:
            test_res = requests.head(file_url, timeout=10)
            if test_res.status_code != 200:
                print(
                    f"❌ [错误] 文件 URL 无法被外部公开访问 (HTTP {test_res.status_code})。"
                )
                return "", []
        except requests.exceptions.RequestException as e:
            print(f"❌ [错误] 测试链接连通性时发生网络异常: {e}")
            return "", []
    elif file_url.startswith("oss://"):
        print("ℹ️ 检测到阿里内部 oss:// 协议链接，跳过 HTTP HEAD 校验，交由 DashScope 解析。")
    # =======================================================================

    # 2. 提交异步转录任务
    submit_url = f"{DASHSCOPE_BASE_URL}/services/audio/asr/transcription"
    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
        "X-DashScope-Async": "enable",
        "X-DashScope-OssResourceResolve": "enable",
    }
    input_payload = {"file_urls": [file_url]}
    if ASR_MODEL.startswith("qwen3-asr"):
        input_payload = {"file_url": file_url}

    parameters = {
        "channel_id": [0],
        "enable_words": True,
    }
    if ASR_LANGUAGE_HINTS:
        parameters["language_hints"] = ASR_LANGUAGE_HINTS

    payload = {
        "model": ASR_MODEL,
        "input": input_payload,
        "parameters": parameters,
    }

    print(f" [API 提交] 正在向 {ASR_MODEL} 发送转录任务...")
    try:
        response = requests.post(
            submit_url, headers=headers, json=payload, timeout=15
        )
        if response.status_code >= 400 and "enable_words" in payload["parameters"]:
            retry_payload = dict(payload)
            retry_payload["parameters"] = dict(payload["parameters"])
            retry_payload["parameters"].pop("enable_words", None)
            print("⚠️ ASR 网关未接受 enable_words 参数，正在移除后重试...")
            response = requests.post(
                submit_url, headers=headers, json=retry_payload, timeout=15
            )
        response.raise_for_status()
        task_response = response.json()

        task_id = task_response.get("output", {}).get("task_id")
        if not task_id:
            print(f"❌ 未能提取到 task_id，API 响应内容: {task_response}")
            return "", []

        print(f" [API 提交成功] 任务ID: {task_id}")
    except Exception as e:
        print(f"❌ 提交任务失败: {e}")
        return "", []

    # 3. 轮询获取任务结果
    result = _poll_for_task_result(task_id)
    if not result:
        return "", []

    # 4. 解析转录结果
    try:
        full_transcript, all_sentences = _parse_asr_transcription_result(result)
        if all_sentences and not any(sentence.get("words") for sentence in all_sentences):
            print("⚠️ ASR 结果没有词级时间戳，停顿分析将无法生成。")
        return full_transcript, all_sentences

    except Exception as e:
        print(f"❌ 解析转录结果时发生异常: {e}")
        return "", []


def _poll_for_task_result(
    task_id: str, max_retries: int = 60, interval: int = 3
) -> Optional[Dict[str, Any]]:
    """根据任务ID轮询，直到任务完成，并自动下载解析转录文本。

    :param task_id: 任务 ID
    :param max_retries: 最大轮询次数（默认 60 次）
    :param interval: 轮询间隔秒数（默认 3 秒）
    """
    # 统一使用与提交任务一致的专属网关任务查询 URL
    poll_url = f"{DASHSCOPE_BASE_URL}/tasks/{task_id}"

    headers = {
        "Authorization": f"Bearer {DASHSCOPE_API_KEY}",
        "Content-Type": "application/json",
    }

    print("⏳ 正在等待转录结果 (开始轮询)...")

    for retry_count in range(1, max_retries + 1):
        try:
            response = requests.get(poll_url, headers=headers, timeout=10)

            if response.status_code != 200:
                print(
                    f"⚠️ 轮询返回异常 HTTP 状态码 [{response.status_code}]: {response.text}"
                )
                time.sleep(interval)
                continue

            task_status_response = response.json()
            output = task_status_response.get("output", {})
            status = output.get("task_status")

            print(
                f"⌛ [{retry_count}/{max_retries}] 当前任务状态: {status}"
            )

            if status == "SUCCEEDED":
                print("🎉 转录任务已完成！正在拉取转录文本结果...")

                # 1. 提取 transcription_url
                transcription_url = output.get("transcription_url")
                if not transcription_url and isinstance(output.get("result"), dict):
                    transcription_url = output["result"].get("transcription_url")
                if not transcription_url and output.get("results"):
                    transcription_url = output["results"][0].get(
                        "transcription_url"
                    )

                if not transcription_url:
                    print(
                        "❌ 未在响应中找到 transcription_url，无法下载结果！"
                    )
                    return None

                print(f"🔗 结果下载地址: {transcription_url}")

                # 2. 发起 GET 请求去下载 JSON 文件（注意：下载公网预签名 OSS 链接时不能加 Header）
                res_detail = requests.get(transcription_url, timeout=15)
                res_detail.raise_for_status()

                transcription_data = res_detail.json()
                print("✅ 成功解析转录文本数据！")
                return transcription_data

            elif status == "FAILED":
                code = output.get("code", "UNKNOWN")
                error_msg = output.get("message", "无具体错误描述")
                print(f"❌ 转录任务失败: [{code}] {error_msg}")
                return None

        except requests.exceptions.RequestException as e:
            print(
                f"⚠️ 第 {retry_count} 次轮询发生网络波动: {e}，将在 {interval}s 后重试..."
            )

        time.sleep(interval)

    print("❌ 轮询超时：任务在规定时间内未能完成。")
    return None

    
def detect_sentence_internal_pauses(all_sentences, threshold_ms=PAUSE_THRESHOLD_MS):
    results = []

    for sent in all_sentences:
        sent_words = sent.get("words") or []
        if len(sent_words) < 2:
            continue

        for i in range(len(sent_words) - 1):
            prev_word = sent_words[i]
            next_word = sent_words[i + 1]

            clean_prev = re.sub(r"[^\w']", "", prev_word["text"])
            clean_next = re.sub(r"[^\w']", "", next_word["text"])
            if not clean_prev or not clean_next:
                continue

            if prev_word.get("end") is None or next_word.get("start") is None:
                continue

            pause_ms = (next_word["start"] - prev_word["end"]) * 1000
            if pause_ms < threshold_ms:
                continue

            results.append(
                {
                    "pause_index": len(results) + 1,
                    "sentence_text": sent.get("sentence_text", ""),
                    "prev_word": clean_prev,
                    "prev_word_raw": prev_word["text"],
                    "prev_word_end_s": round(prev_word["end"], 3),
                    "next_word": clean_next,
                    "next_word_raw": next_word["text"],
                    "next_word_start_s": round(next_word["start"], 3),
                    "pause_duration_ms": round(pause_ms, 1),
                    "has_comma_after_prev": "," in prev_word["text"]
                    or prev_word.get("punctuation") == ",",
                }
            )

    return results


def compute_speaking_rate(all_sentences):
    total_words_count = 0
    total_syllables = 0

    if not all_sentences:
        return {
            "words_per_minute_wpm": 0.0,
            "syllables_per_minute_spm": 0.0,
            "total_words_detected": 0,
            "effective_duration_s": 0.0,
            "articulated_duration_s": 0.0,
        }

    timestamped_words = [
        word
        for sentence in all_sentences
        for word in (sentence.get("words") or [])
        if word.get("start") is not None and word.get("end") is not None
    ]

    if not timestamped_words:
        fallback_word_count = sum(
            len(re.findall(r"\b[\w']+\b", str(sentence.get("sentence_text", ""))))
            for sentence in all_sentences
        )
        return {
            "words_per_minute_wpm": 0.0,
            "syllables_per_minute_spm": 0.0,
            "total_words_detected": fallback_word_count,
            "effective_duration_s": 0.0,
            "articulated_duration_s": 0.0,
        }

    timestamped_words.sort(key=lambda word: (word["start"], word["end"]))
    first_word_start = timestamped_words[0]["start"]
    last_word_end = timestamped_words[-1]["end"]
    total_duration_s = last_word_end - first_word_start

    articulated_duration_s = 0.0
    for w in timestamped_words:
        text_norm = re.sub(r"[^\w]", "", str(w.get("text", "")).lower())
        if not text_norm:
            continue
        total_words_count += 1
        articulated_duration_s += max(float(w["end"]) - float(w["start"]), 0.0)
        syllables = len(re.findall(r"[aeiouy]+", text_norm))
        total_syllables += syllables if syllables > 0 else 1

    if total_duration_s <= 0:
        return {
            "words_per_minute_wpm": 0.0,
            "syllables_per_minute_spm": 0.0,
            "total_words_detected": total_words_count,
            "effective_duration_s": 0.0,
            "articulated_duration_s": round(articulated_duration_s, 2),
        }

    return {
        "words_per_minute_wpm": round((total_words_count / total_duration_s) * 60, 1),
        "syllables_per_minute_spm": round((total_syllables / total_duration_s) * 60, 1),
        "total_words_detected": total_words_count,
        "effective_duration_s": round(total_duration_s, 2),
        "articulated_duration_s": round(articulated_duration_s, 2),
    }


# ---------------------------------------------------------------------------
# DeepSeek 处理逻辑
# ---------------------------------------------------------------------------


QA_SYSTEM_PROMPT = """You are an IELTS Speaking transcript formatter.

Your task:
1. Restore punctuation and capitalization if needed.
2. Identify speakers: Examiner / Candidate.
3. Split into one-question-one-answer turns.
4. Assign a short, specific topic label for each Q&A based on the QUESTION content.
5. Exclude post-test feedback / score discussion.

IMPORTANT:
- DO NOT rewrite grammar.
- DO NOT improve vocabulary.
- DO NOT paraphrase.
- DO NOT delete filler words.
- Keep every spoken word exactly the same.



--- CRITICAL JSON ESCAPING RULES ---
1. EVERY double quote inside a spoken string MUST be escaped with a backslash.
   - ❌ INCORRECT: "text": "I said "yes" to him."
   - ✅ CORRECT:   "text": "I said \"yes\" to him."
2. Do NOT use unescaped line breaks inside values.
3. Keep every spoken word exactly as said (do not delete fillers like 'um', 'ah', 'like').

--- REQUIRED OUTPUT VALID JSON FORMAT ---
Return ONLY a valid JSON object matching this structure:

{
  "Final score": "Band X.X",
  "turns": [
    {
      "speaker": "Examiner",
      "type": "question",
      "topic": "hobbies",
      "text": "Do you enjoy reading books?"
    },
    {
      "speaker": "Candidate",
      "type": "answer",
      "topic": "hobbies",
      "text": "Well, um, I recently finished a book called \"The Great Gatsby\", and it was great."
    }
  ]
}
"""

SPEAKER_LABEL_PROMPT = """You label IELTS Speaking sentences as Examiner, Candidate, or Feedback.

Return ONLY valid JSON:
{"labels": [{"sentence": "<exact input sentence>", "speaker": "Examiner"|"Candidate"|"Feedback"}]}
"""


def _extract_json_content(raw: str) -> dict:
    if not raw or not raw.strip():
        raise ValueError("DeepSeek 返回了空内容 (Empty Response)")

    text = raw.strip()

    # 1. 尝试正则提取 ```json ... ``` 中的内容
    match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if match:
        text = match.group(1)
    else:
        # 2. 如果没有 markdown 标签，提取从第一个 { 到最后一个 } 的内容（去杂质）
        match_bare = re.search(r"(\{.*\})", text, re.DOTALL)
        if match_bare:
            text = match_bare.group(1)

    # 3. 优先尝试标准 json.loads 解析
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # 4. 正则修复：修正口语转录文本中未转义的内部双引号 (例如 "text": "I said "yes" to him")
    def fix_unescaped_quotes(json_str: str) -> str:
        def replace_inner(m):
            prefix, content, suffix = m.group(1), m.group(2), m.group(3)
            # 将内容内部未转义的双引号替换为 \"
            clean_content = re.sub(r'(?<!\\)"', r'\"', content)
            return f'{prefix}{clean_content}{suffix}'

        # 匹配常见的文本字段名称（如 text, sentence, topic 等）
        pattern = r'("(?:text|sentence|topic)"\s*:\s*")([^"\\]*(?:\\.[^"\\]*)*)(")'
        return re.sub(pattern, replace_inner, json_str)

    try:
        text_fixed = fix_unescaped_quotes(text)
        return json.loads(text_fixed)
    except json.JSONDecodeError:
        pass

    # 5. 终极兜底：调用 repair_json 修复缺失括号/复杂语法中断等截断问题
    try:
        repaired_result = repair_json(text_fixed if 'text_fixed' in locals() else text, return_objects=True)
        if isinstance(repaired_result, dict):
            return repaired_result
        elif isinstance(repaired_result, str):
            return json.loads(repaired_result)
    except Exception as e:
        raise ValueError(f"所有修复机制均失败，无法解析 JSON。文本开头: {text[:100]}... 错误信息: {e}")


def _response_content_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
                continue
            text = _response_field(item, "text")
            if isinstance(text, str):
                parts.append(text)
        return "".join(parts)
    return ""


def _extract_deepseek_message(response: Any) -> str:
    choices = _response_field(response, "choices") or []
    if not choices:
        raise ValueError("DeepSeek 返回了空 choices")

    choice = choices[0]
    message = _response_field(choice, "message")
    content = _response_content_text(_response_field(message, "content"))
    reasoning = _response_content_text(
        _response_field(message, "reasoning_content")
        or _response_field(choice, "reasoning_content")
    )
    finish_reason = _response_field(choice, "finish_reason") or "unknown"
    refusal = _response_field(message, "refusal")
    usage = _response_field(response, "usage")
    completion_tokens = _response_field(usage, "completion_tokens")

    print(
        "[DeepSeek] response "
        f"model={_response_field(response, 'model') or DEEPSEEK_MODEL} "
        f"finish_reason={finish_reason!r} "
        f"content_chars={len(content)} "
        f"reasoning_chars={len(reasoning)} "
        f"refusal={bool(refusal)} "
        f"completion_tokens={completion_tokens!r}",
        flush=True,
    )

    if not content.strip():
        details = [
            f"finish_reason={finish_reason!r}",
            f"reasoning_chars={len(reasoning)}",
        ]
        if refusal:
            details.append(f"refusal={str(refusal)[:160]!r}")
        raise ValueError(
            "DeepSeek 返回了空内容 (Empty Response; "
            + ", ".join(details)
            + ")"
        )

    return content


def call_deepseek_json(system_prompt: str, user_prompt: str, retries: int = 2) -> dict:
    last_error = ""
    for attempt in range(retries + 1):
        try:
            request_kwargs = {
                "model": DEEPSEEK_MODEL,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                "temperature": 0.1,
                "max_tokens": 8192,
                # JSON 结构化输出与思考模式同时开启时，部分百炼 DeepSeek
                # 兼容端点会返回空 message.content。
                "extra_body": {"enable_thinking": False},
                "response_format": {"type": "json_object"},
            }

            response = deepseek_client.chat.completions.create(**request_kwargs)
            content = _extract_deepseek_message(response)
            print(
                "[DeepSeek] content preview="
                f"{content[:240].replace(chr(10), ' ')}",
                flush=True,
            )
            return _extract_json_content(content)

        except Exception as e:
            last_error = f"{type(e).__name__}: {e}"
            print(
                f"⚠️ DeepSeek 解析失败 (第 {attempt + 1}/{retries + 1} 次尝试): "
                f"{last_error}",
                flush=True,
            )
            if attempt < retries:
                print("🔄 正在重试请求 DeepSeek...")
                time.sleep(min(2 * (attempt + 1), 5))
            else:
                print("❌ 达到最大重试次数，触发降级兜底方案。")
                return {
                    "Final score": "Band unknown",
                    "turns": [],
                    "_deepseek_error": last_error,
                }

def format_qa_with_deepseek(transcript: str, band_hint: str | None = None) -> dict:
    hint = f"\nKnown official band score hint: {band_hint}\n" if band_hint else ""
    data = call_deepseek_json(
        QA_SYSTEM_PROMPT,
        f"Format this IELTS speaking transcript into Q&A turns.{hint}\n\n{transcript}",
    )
    if band_hint and not str(data.get("Final score", "")).strip():
        data["Final score"] = band_hint if band_hint.startswith("Band") else f"Band {band_hint}"
    return data


def label_sentences_with_deepseek(sentences: list[str]) -> dict[str, str]:
    if not sentences:
        return {}

    mapping: dict[str, str] = {}
    batch_size = 40
    for i in range(0, len(sentences), batch_size):
        batch = sentences[i : i + batch_size]
        payload = json.dumps({"sentences": batch}, ensure_ascii=False)
        result = call_deepseek_json(SPEAKER_LABEL_PROMPT, f"Label each sentence:\n{payload}")
        for item in result.get("labels", []):
            sent = (item.get("sentence") or "").strip()
            speaker = (item.get("speaker") or "").strip()
            if sent and speaker:
                mapping[sent] = speaker

    for s in sentences:
        if s not in mapping:
            mapping[s] = heuristic_speaker(s)
    return mapping


def heuristic_speaker(sentence: str) -> str:
    s = sentence.strip()
    lower = s.lower()
    examiner_starts = (
        "all right", "alright", "okay", "ok,", "ok.", "right,",
        "so can you", "so could you", "and are you", "and do you",
        "and what", "and have you", "now let's", "now we're",
        "we'll move", "let's move", "absolutely", "nice.",
        "good attitude", "thank you",
    )
    if any(lower.startswith(p) for p in examiner_starts):
        return "Examiner"
    if s.endswith("?") and not lower.startswith(("i ", "my ", "we ", "yes", "no", "well")):
        return "Examiner"
    if "feedback" in lower or "your score" in lower or "estimated" in lower:
        return "Feedback"
    return "Candidate"


def extract_band_from_name(name: str) -> str:
    match = re.search(r"Band\s*([0-9]+(?:\.[0-9]+)?)", name, re.IGNORECASE)
    return f"Band {match.group(1)}" if match else "Band unknown"


def parse_band_float(band_str: str) -> float:
    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", str(band_str))
    return float(match.group(1)) if match else 0.0


# ---------------------------------------------------------------------------
# 停顿分类与特征构造
# ---------------------------------------------------------------------------

def normalize_filler_token(word: str) -> str:
    return re.sub(r"[^\w]", "", (word or "").lower())


def is_filler_word(word: str) -> bool:
    return normalize_filler_token(word) in FILLER_WORDS


def pause_has_comma(pause: dict) -> bool:
    if pause.get("has_comma_after_prev"):
        return True
    if "," in (pause.get("prev_word_raw") or ""):
        return True

    prev = pause.get("prev_word", "")
    nxt = pause.get("next_word", "")
    sentence = pause.get("sentence_text", "")
    if not prev or not nxt or not sentence:
        return False

    pattern = re.compile(rf"\b{re.escape(prev)}\s*,\s*{re.escape(nxt)}\b", re.IGNORECASE)
    return bool(pattern.search(sentence))


def is_mid_sentence_pause(pause: dict) -> bool:
    duration = float(pause.get("pause_duration_ms", 0))
    has_comma = pause_has_comma(pause)
    return True if not has_comma else duration > 500


def is_filler_pause(pause: dict) -> bool:
    return is_filler_word(pause.get("prev_word", "")) or is_filler_word(pause.get("next_word", ""))


def bucket_mid_pause(duration_ms: float) -> str | None:
    if duration_ms < MIN_PAUSE_MS: return None
    if duration_ms < 200: return "100_200"
    if duration_ms <= 500: return "200_500"
    return "gt_500"


def bucket_filler_pause(duration_ms: float) -> str | None:
    if duration_ms < MIN_PAUSE_MS: return None
    if duration_ms <= 250: return "100_250"
    return "gt_250"


def classify_candidate_pauses(pauses: list[dict]) -> dict:
    mid_pauses, filler_pauses = [], []
    mid_counts = {"100_200": 0, "200_500": 0, "gt_500": 0}
    filler_counts = {"100_250": 0, "gt_250": 0}
    ignored_lt_100 = 0

    for pause in pauses:
        duration = float(pause.get("pause_duration_ms", 0))
        if duration < MIN_PAUSE_MS:
            ignored_lt_100 += 1
            continue

        enriched = dict(pause)
        enriched["has_comma"] = pause_has_comma(pause)

        if is_filler_pause(pause):
            bucket = bucket_filler_pause(duration)
            if bucket:
                enriched["filler_bucket"] = bucket
                filler_pauses.append(enriched)
                filler_counts[bucket] += 1
            continue

        if is_mid_sentence_pause(pause):
            bucket = bucket_mid_pause(duration)
            if bucket:
                enriched["mid_bucket"] = bucket
                mid_pauses.append(enriched)
                mid_counts[bucket] += 1

    return {
        "mid_sentence_pauses": mid_pauses,
        "filler_pauses": filler_pauses,
        "mid_counts": mid_counts,
        "filler_counts": filler_counts,
        "ignored_lt_100_count": ignored_lt_100,
    }


def build_fluency_features(speaking_rate: dict, classified: dict) -> dict:
    mid = classified["mid_counts"]
    filler = classified["filler_counts"]
    wpm = float(speaking_rate.get("words_per_minute_wpm", 0.0))

    vector = {
        "speaking_rate_wpm": wpm,
        "mid_pause_100_200": mid["100_200"],
        "mid_pause_200_500": mid["200_500"],
        "mid_pause_gt_500": mid["gt_500"],
        "filler_pause_100_250": filler["100_250"],
        "filler_pause_gt_250": filler["gt_250"],
    }
    raw_values = [
        vector["speaking_rate_wpm"], vector["mid_pause_100_200"],
        vector["mid_pause_200_500"], vector["mid_pause_gt_500"],
        vector["filler_pause_100_250"], vector["filler_pause_gt_250"]
    ]
    normalized_values = normalize_fluency_features(raw_values)
    vector["raw_values"] = raw_values
    vector["values"] = normalized_values
    vector["normalized_values"] = normalized_values
    vector["dim_names"] = FLUENCY_DIM_NAMES.copy()
    return vector



def fluency_features_to_text(band: str, features: dict, source: str) -> str:
    features = ensure_normalized_fluency_features(features)
    normalized = ", ".join(f"{value:.4f}" for value in features["normalized_values"])
    return (
        f"IELTS Speaking Fluency Profile\n"
        f"Band: {band}\nSource: {source}\n"
        f"Speaking rate (WPM): {features['speaking_rate_wpm']}\n"
        f"Mid-sentence pauses 100-200ms: {features['mid_pause_100_200']}\n"
        f"Mid-sentence pauses 200-500ms: {features['mid_pause_200_500']}\n"
        f"Mid-sentence pauses >500ms: {features['mid_pause_gt_500']}\n"
        f"Filler pauses 100-250ms: {features['filler_pause_100_250']}\n"
        f"Filler pauses >250ms: {features['filler_pause_gt_250']}\n"
        f"Normalized fluency vector ([0,1]): [{normalized}]\n"
    )


def build_filtered_pauses_json(band: str, source_name: str, features: dict, classified: dict) -> dict:
    features = ensure_normalized_fluency_features(features)
    mid_by_bucket = {"100_200": [], "200_500": [], "gt_500": []}
    for p in classified["mid_sentence_pauses"]:
        bucket = p.get("mid_bucket")
        if bucket in mid_by_bucket: mid_by_bucket[bucket].append(p)

    filler_by_bucket = {"100_250": [], "gt_250": []}
    for p in classified["filler_pauses"]:
        bucket = p.get("filler_bucket")
        if bucket in filler_by_bucket: filler_by_bucket[bucket].append(p)

    return {
        "source": source_name,
        "band": band,
        "fluency_features_6d": {
            "dim_names": features["dim_names"],
            "values": features["values"],
            "raw_values": features["raw_values"],
            "normalized_values": features["normalized_values"],
            "normalization_min": FEATURE_MIN.tolist(),
            "normalization_max": FEATURE_MAX.tolist(),
            "speaking_rate_wpm": features["speaking_rate_wpm"],
            "mid_pause_100_200": features["mid_pause_100_200"],
            "mid_pause_200_500": features["mid_pause_200_500"],
            "mid_pause_gt_500": features["mid_pause_gt_500"],
            "filler_pause_100_250": features["filler_pause_100_250"],
            "filler_pause_gt_250": features["filler_pause_gt_250"],
        },
        "pauses_by_dimension": {
            "speaking_rate_wpm": {"value": features["speaking_rate_wpm"], "note": "语速维度，无停顿列表", "pauses": []},
            "mid_pause_100_200": {"count": features["mid_pause_100_200"], "pauses": mid_by_bucket["100_200"]},
            "mid_pause_200_500": {"count": features["mid_pause_200_500"], "pauses": mid_by_bucket["200_500"]},
            "mid_pause_gt_500": {"count": features["mid_pause_gt_500"], "pauses": mid_by_bucket["gt_500"]},
            "filler_pause_100_250": {"count": features["filler_pause_100_250"], "pauses": filler_by_bucket["100_250"]},
            "filler_pause_gt_250": {"count": features["filler_pause_gt_250"], "pauses": filler_by_bucket["gt_250"]},
        },
    }



# ===========================================================================
# 1. 向量数据库与 Embedding 客户端封装
# ===========================================================================

def get_aliyun_embedding(
    text: str,
    *,
    text_type: str | None = None,
    dimension: int = 1024,
) -> list[float]:
    """Call DashScope text-embedding-v4 and return a dense vector."""
    if not DASHSCOPE_API_KEY:
        raise RuntimeError("DASHSCOPE_API_KEY is not configured.")

    resp = TextEmbedding.call(
        model="text-embedding-v4",
        input=text,
        api_key=DASHSCOPE_API_KEY,
        workspace=DASHSCOPE_WORKSPACE_ID,
        text_type=text_type,
        dimension=dimension,  # keep this aligned with the Chroma vectors.
    )
    if resp.status_code == 200:
        return resp.output["embeddings"][0]["embedding"]

    raise RuntimeError(
        "Aliyun Embedding Error: "
        f"status={resp.status_code}, code={resp.code}, message={resp.message}"
    )


class VectorRetriever:
    """ChromaDB 检索器：负责流利度与内容向量的比对"""

    def __init__(self, content_dir: str, fluency_dir: str):
        self.content_dir = Path(content_dir)
        self.fluency_dir = Path(fluency_dir)
        print(
            "[Vector] init "
            f"content_dir={self.content_dir} "
            f"content_db={(self.content_dir / 'chroma.sqlite3').exists()} "
            f"fluency_dir={self.fluency_dir} "
            f"fluency_db={(self.fluency_dir / 'chroma.sqlite3').exists()}"
        )
        self.content_client = chromadb.PersistentClient(path=str(self.content_dir))
        self.fluency_client = chromadb.PersistentClient(path=str(self.fluency_dir))
        
        self.content_coll = self.content_client.get_collection(name="ielts_content")
        self.fluency_coll = self.fluency_client.get_collection(name="ielts_fluency")
        print(
            "[Vector] collections "
            f"ielts_content={self.content_coll.count()} "
            f"ielts_fluency={self.fluency_coll.count()}"
        )

    def search_similar_fluency(self, fluency_query_embedding: list[float], top_k: int = 3) -> list[dict]:
        """根据流利度描述文本的 embedding 进行最近邻检索。

        返回结果会包含 fluency_features_6d，其中 values/normalized_values 为 [0,1]
        归一化后的 6 维向量，raw_values 与按维度命名字段保留原始统计值。
        """
        try:
            results = self.fluency_coll.query(
                query_embeddings=[fluency_query_embedding],
                n_results=top_k,
                include=["metadatas", "distances"]
            )
        except Exception as exc:
            print(
                "[Vector][WARN] fluency Chroma query failed: "
                f"{type(exc).__name__}: {exc}"
            )
            return []
        matched = []
        if results and results.get("metadatas"):
            for meta, dist in zip(results["metadatas"][0], results["distances"][0]):
                # copy original meta to avoid mutating client data
                item = dict(meta) if meta else {}

                # Build fluency_features_6d from available metadata
                dims = FLUENCY_DIM_NAMES.copy()

                def parse_json_values(key: str) -> list[float] | None:
                    value = item.get(key)
                    if isinstance(value, str):
                        try:
                            parsed = json.loads(value)
                        except json.JSONDecodeError:
                            return None
                    else:
                        parsed = value
                    if isinstance(parsed, list) and len(parsed) == len(dims):
                        return [float(v) for v in parsed]
                    return None

                raw_values = parse_json_values("raw_values_json")
                if raw_values is None:
                    raw_values = [float(item.get(d, 0.0) or 0.0) for d in dims]

                normalized_values = parse_json_values("normalized_values_json")
                if normalized_values is None:
                    norm_from_fields = [item.get(f"norm_{d}") for d in dims]
                    if all(v is not None for v in norm_from_fields):
                        normalized_values = [float(v) for v in norm_from_fields]
                    else:
                        normalized_values = normalize_fluency_features(raw_values)

                ff = {
                    "dim_names": dims,
                    "values": normalized_values,
                    "raw_values": raw_values,
                    "normalized_values": normalized_values,
                    "normalization_min": FEATURE_MIN.tolist(),
                    "normalization_max": FEATURE_MAX.tolist(),
                }

                # Add raw and normalized per-dimension named fields into the ff object
                for name, raw_val, norm_val in zip(dims, raw_values, normalized_values):
                    ff[name] = raw_val
                    ff[f"norm_{name}"] = norm_val

                # Attach nested object and remove top-level duplicate dimension keys if present
                item["fluency_features_6d"] = ff
                for d in dims + [f"norm_{d}" for d in dims]:
                    if d in item:
                        try:
                            del item[d]
                        except KeyError:
                            pass

                # round distance and include
                item["distance"] = round(dist, 4)
                matched.append(item)
        return matched

    def search_similar_content(self, text: str, top_k: int = 3) -> list[dict]:
        """根据候选人转录文本检索相似答题范例/历史样本"""
        try:
            embedding = get_aliyun_embedding(text, text_type="query")
        except Exception as exc:
            print(
                "[Vector][WARN] content embedding failed: "
                f"{type(exc).__name__}: {exc}"
            )
            return []

        try:
            results = self.content_coll.query(
                query_embeddings=[embedding],
                n_results=top_k,
                include=["documents", "metadatas", "distances"]
            )
        except Exception as exc:
            print(
                "[Vector][WARN] content Chroma query failed: "
                f"{type(exc).__name__}: {exc}"
            )
            return []
        matched = []
        if results and results.get("metadatas"):
            for doc, meta, dist in zip(results["documents"][0], results["metadatas"][0], results["distances"][0]):
                item = dict(meta)
                item["matched_text"] = doc
                item["distance"] = round(dist, 4)
                matched.append(item)
        return matched


# ===========================================================================
# 2. DeepSeek 语法与词汇深度评估器
# ===========================================================================

def load_criteria_rules(file_path: str) -> str:
    """读取本地 criteria.txt 评分标准"""
    p = Path(file_path)
    if not p.exists():
        print(
            "[Criteria][WARN] file not found; "
            f"path={file_path}; using built-in descriptors."
        )
        return "Refer to standard IELTS Speaking Band Descriptors."
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def evaluate_language_with_deepseek(
    candidate_turns: list[dict], 
    criteria_text: str
) -> dict:
    """使用 DeepSeek 依据 criteria.txt 严苛评估 Lexical Resource 和 Grammatical Range & Accuracy"""
    
    system_prompt = f"""You are an official, highly strict IELTS Speaking Examiner.
Analyze the Candidate's responses carefully based on the provided Official Criteria.

--- OFFICIAL CRITERIA ---
{criteria_text}
-------------------------

CRITICAL EVALUATION FOCUS:
1. Paraphrasing Ability: Check if the candidate can rephrase examiner questions or key concepts instead of repeating verbatim.
2. CEFR Vocabulary Level: Determine vocabulary breadth (A2, B1, B2, C1, C2), idiomatic usage, and collocation accuracy.
3. Sentence Structure Variety: Evaluate if the candidate uses a balanced mix of simple and complex sentences (subordinate clauses, relative clauses, conditionals). Penalize heavy reliance on single simple structures.
4. Grammatical Range & Accuracy:
   - Minor tense slips or occasional awkward phrasing in complex structures are NORMAL for Band 7.0 or upper grade.
   - Do NOT over-penalize a single minor mistake if the sentence structure shows good complexity.
   - Downgrade to 6.0 if errors cause confusion or if simple sentences contain basic structural mistakes.
Return ONLY valid JSON format:
{{
  "lexical_resource": {{
    "band": ,
    "cefr_level": "",
    "paraphrasing_ability": "",
    "analysis": "Detailed lexical feedback..."
  }},
  "grammatical_range_accuracy": {{
    "band": ,
    "structure_variety": "",
    "simple_sentence_errors": ,
    "complex_sentence_errors": ,
    "error_examples": [
      {{"sentence": "...", "error": "...", "correction": "..."}}
    ],
    "analysis": "Detailed grammar feedback..."
  }}
}}
"""

    user_payload = {
        "candidate_responses": [
            f"[{t.get('topic', 'Q&A')}] Speaker: {t['speaker']} -> {t['text']}"
            for t in candidate_turns if t.get("speaker") == "Candidate"
        ]
    }

    return call_deepseek_json(
        system_prompt,
        json.dumps(user_payload, ensure_ascii=False),
    )


def _grammar_sentence_payload(sentences: Any) -> list[dict]:
    if isinstance(sentences, str):
        text = sentences.strip()
        return [{"sentence_index": 1, "sentence": text}] if text else []

    if not isinstance(sentences, list):
        return []

    payload = []
    for index, item in enumerate(sentences, start=1):
        if isinstance(item, dict):
            sentence_text = (
                item.get("sentence_text")
                or item.get("original_sentence")
                or item.get("sentence")
                or item.get("text")
                or ""
            )
            sentence_index = item.get("sentence_index") or item.get("index") or index
        else:
            sentence_text = str(item)
            sentence_index = index

        sentence_text = str(sentence_text).strip()
        if sentence_text:
            payload.append(
                {
                    "sentence_index": sentence_index,
                    "sentence": sentence_text,
                }
            )

    return payload


def _normalize_grammar_errors(value: Any) -> list[dict]:
    if isinstance(value, dict):
        items = (
            value.get("grammar_errors")
            or value.get("grammar_error_table")
            or value.get("errors")
            or value.get("error_examples")
            or []
        )
    else:
        items = value

    if not isinstance(items, list):
        return []

    normalized = []
    for index, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue

        sentence = str(
            item.get("original_sentence")
            or item.get("sentence")
            or item.get("sentence_text")
            or item.get("text")
            or ""
        ).strip()
        grammar_error = str(
            item.get("grammar_error")
            or item.get("error")
            or item.get("issue")
            or ""
        ).strip()
        correction = str(
            item.get("correction")
            or item.get("corrected_sentence")
            or item.get("improved_sentence")
            or ""
        ).strip()

        if not sentence and not grammar_error and not correction:
            continue

        normalized.append(
            {
                "sentence_index": item.get("sentence_index") or item.get("index") or index,
                "original_sentence": sentence,
                "error_type": str(item.get("error_type") or item.get("type") or "").strip(),
                "grammar_error": grammar_error,
                "correction": correction,
                "explanation": str(
                    item.get("explanation")
                    or item.get("analysis")
                    or item.get("reason")
                    or ""
                ).strip(),
            }
        )

    return normalized


def analyze_sentence_grammar_errors(sentences: Any) -> dict:
    """Return sentence-level grammar errors and corrections for report tables."""
    sentence_payload = _grammar_sentence_payload(sentences)
    if not sentence_payload:
        return {"grammar_errors": []}

    system_prompt = """You are an IELTS Speaking grammar examiner.
Task: Identify real sentence-level GRAMMAR errors in the candidate's transcript that would negatively impact their score (e.g., tense inconsistencies, subject-verb agreement, improper clause structures, wrong prepositions, incorrect word forms).

CRITICAL CONSTRAINTS (Ignore ASR/STT Artifacts):
    IGNORE ASR/STT Formatting Issues:
   - Extra/missing spaces in contractions (e.g., treat "I ' m", "don ' t" as "I'm", "don't").
   - Missing or erroneous punctuation/capitalization caused by speech-to-text software.
   - Minor typos or phonetic transcription glitches.

Return ONLY a valid JSON object in this exact structure:
{
  "grammar_errors": [
    {
      "sentence_index": 1,
      "original_sentence": "...",
      "error_type": "tense | article | preposition | agreement | word_order | clause | other",
      "grammar_error": "Short description of the grammar problem",
      "correction": "Corrected sentence preserving the candidate's meaning",
      "explanation": "Brief reason for the correction"
    }
  ]
}

Rules:
- Only include real grammar errors. Do not include pronunciation, fluency, vocabulary-only, or style-only issues.
- Keep corrections natural but close to the original meaning.
- If there are no grammar errors, return {"grammar_errors": []}.
"""

    result = call_deepseek_json(
        system_prompt,
        json.dumps({"sentences": sentence_payload}, ensure_ascii=False),
    )
    return {"grammar_errors": _normalize_grammar_errors(result)}


# ===========================================================================
# 3. 综合评分算法（集成向量匹配 + LLM）
# ===========================================================================

def estimate_fluency_band(fluency_features: dict, matched_fluency_samples: list[dict]) -> float:
    """严格基于 6 维流利度特征向量及近邻匹配样本计算流利度得分"""
    # 1. 判空校验：输入字典为空或近邻匹配样本为空，直接返回 0.0
    if not fluency_features:
        # 建议：使用项目统一的 logger，如 logging.getLogger(__name__)
        print("[estimate_fluency_band] 输入字典 fluency_features 为空，返回 0.0")
        return 0.0
    fluency_features = ensure_normalized_fluency_features(fluency_features)
    
    if not matched_fluency_samples:
        print("[estimate_fluency_band] 近邻匹配样本 matched_fluency_samples 为空，返回 0.0")
        return 0.0

    # 2. 严格校验 6 个核心特征维度是否存在
    required_dims = FLUENCY_DIM_NAMES
    for dim in required_dims:
        if fluency_features.get(dim) is None:
            print(f"[estimate_fluency_band] 特征维度 '{dim}' 为空，返回 0.0")
            return 0.0

    # 3. 基于归一化 6 维向量距离进行加权平均；旧库缺字段时回退到 Chroma distance
    candidate_norm = fluency_features["normalized_values"]
    total_weight = 0.0
    weighted_band = 0.0

    for sample in matched_fluency_samples:
        band_str = sample.get("band", "0.0")
        match = re.search(r"([0-9]+(?:\.[0-9]+)?)", str(band_str))
        band_val = float(match.group(1)) if match else 0.0

        sample_ff = sample.get("fluency_features_6d") or {}
        sample_norm = sample_ff.get("normalized_values") or sample_ff.get("values")
        if isinstance(sample_norm, list) and len(sample_norm) == len(candidate_norm):
            dist = sum((candidate_norm[i] - float(sample_norm[i])) ** 2 for i in range(len(candidate_norm))) ** 0.5
            sample["normalized_6d_distance"] = round(dist, 4)
        else:
            dist = float(sample.get("distance", 1.0))
        weight = 1.0 / (dist + 1e-5)  # 距离越小，权重越高

        weighted_band += band_val * weight
        total_weight += weight

    if total_weight == 0.0:
        return 0.0

    calculated_band = weighted_band / total_weight
    
    # 4. 四舍五入至雅思 0.5 档位
    return round(calculated_band * 2) / 2


def evaluate_ielts_candidate(
    candidate_turns: list[dict],
    fluency_features: dict,
    full_transcript: str
) -> dict:
    """主执行函数：向量检索匹配 + 规则打分 + 全维度雅思成绩报告生成"""
    total_start = time.time()
    evaluation_warnings: list[str] = []
    fluency_features = ensure_normalized_fluency_features(fluency_features)
    
    # 1. 初始化检索器与加载规则
    print("[Eval] start evaluate_ielts_candidate")
    try:
        retriever = VectorRetriever(CONTENT_VECTOR_DIR, FLUENCY_VECTOR_DIR)
    except Exception as exc:
        warning = (
            "[Vector][WARN] retriever init failed: "
            f"{type(exc).__name__}: {exc}"
        )
        print(warning)
        evaluation_warnings.append(warning)
        retriever = None

    criteria_text = load_criteria_rules(CRITERIA_PATH)
    print(
        "[Eval] criteria "
        f"path={CRITERIA_PATH} exists={Path(CRITERIA_PATH).exists()} "
        f"chars={len(criteria_text)}"
    )

    # 2. 向量检索 (Fluency & Content)
    
    normalized_fluency = ", ".join(f"{value:.4f}" for value in fluency_features["normalized_values"])
    fluency_text_for_embedding = (
        f"IELTS Speaking Fluency Profile\n"
        f"Speaking rate (WPM): {fluency_features.get('speaking_rate_wpm', 0)}\n"
        f"Mid-sentence pauses 100-200ms: {fluency_features.get('mid_pause_100_200', 0)}\n"
        f"Mid-sentence pauses 200-500ms: {fluency_features.get('mid_pause_200_500', 0)}\n"
        f"Mid-sentence pauses >500ms: {fluency_features.get('mid_pause_gt_500', 0)}\n"
        f"Filler pauses 100-250ms: {fluency_features.get('filler_pause_100_250', 0)}\n"
        f"Filler pauses >250ms: {fluency_features.get('filler_pause_gt_250', 0)}\n"
        f"Normalized fluency vector ([0,1]): [{normalized_fluency}]"
    )

    matched_fluency: list[dict] = []
    matched_content: list[dict] = []

    if retriever is not None:
        try:
            t = time.time()
            print(
                "[Vector] fluency embedding start "
                f"endpoint={DASHSCOPE_BASE_URL} "
                f"workspace={'configured' if DASHSCOPE_WORKSPACE_ID else 'default'} "
                f"text_chars={len(fluency_text_for_embedding)}"
            )
            fluency_embedding_1024d = get_aliyun_embedding(
                fluency_text_for_embedding,
                text_type="query",
                dimension=1024,
            )
            print(
                "[Vector] fluency embedding ok "
                f"dim={len(fluency_embedding_1024d)} "
                f"time={time.time() - t:.2f}s"
            )
            matched_fluency = retriever.search_similar_fluency(
                fluency_embedding_1024d,
                top_k=3,
            )
            print(f"[Vector] fluency matches={len(matched_fluency)}")
        except Exception as exc:
            warning = (
                "[Vector][WARN] fluency retrieval skipped: "
                f"{type(exc).__name__}: {exc}"
            )
            print(warning)
            evaluation_warnings.append(warning)

        try:
            t = time.time()
            print(
                "[Vector] content search start "
                f"transcript_chars={len(full_transcript)}"
            )
            matched_content = retriever.search_similar_content(
                full_transcript,
                top_k=2,
            )
            print(
                "[Vector] content matches="
                f"{len(matched_content)} time={time.time() - t:.2f}s"
            )
        except Exception as exc:
            warning = (
                "[Vector][WARN] content retrieval skipped: "
                f"{type(exc).__name__}: {exc}"
            )
            print(warning)
            evaluation_warnings.append(warning)
    else:
        print("[Vector][WARN] retriever unavailable; vector retrieval skipped")

    # 3. 计算流利度分数
    fluency_band = estimate_fluency_band(fluency_features, matched_fluency)

    # 4. 调用 DeepSeek 进行 Lexical 与 Grammar 严苛判定
    try:
        t = time.time()
        print(
            "[DeepSeek Eval] start "
            f"candidate_turns={len(candidate_turns)} "
            f"endpoint={DASHSCOPE_COMPATIBLE_BASE_URL}"
        )
        llm_lang_eval = evaluate_language_with_deepseek(
            candidate_turns,
            criteria_text,
        )
        print(f"[DeepSeek Eval] success time={time.time() - t:.2f}s")
    except Exception as exc:
        warning = (
            "[DeepSeek Eval][WARN] language evaluation skipped: "
            f"{type(exc).__name__}: {exc}"
        )
        print(warning)
        evaluation_warnings.append(warning)
        llm_lang_eval = {
            "lexical_resource": {
                "band": 6.0,
                "analysis": "Skipped because the upstream language model request failed.",
                "error": str(exc),
            },
            "grammatical_range_accuracy": {
                "band": 6.0,
                "analysis": "Skipped because the upstream language model request failed.",
                "error": str(exc),
            },
            "error": str(exc),
        }

    # 5. 提取各维度分数并计算总分 (Overall Band)
    lr_band = parse_band_float(
        llm_lang_eval.get("lexical_resource", {}).get("band", 6.0)
    ) or 6.0
    gra_band = parse_band_float(
        llm_lang_eval.get("grammatical_range_accuracy", {}).get("band", 6.0)
    ) or 6.0
    
    # 注：发音分 (Pronunciation) 若无声学模型可先参考流利度或设为基准分
    pron_band = fluency_band  

    overall_raw = (fluency_band + lr_band + gra_band + pron_band) / 4.0
    # 雅思总分向上取整规则 (例如 6.25 -> 6.5, 6.75 -> 7.0)
    overall_band = round(overall_raw * 2) / 2

    # 6. 构建完整评估报告
    report = {
        "overall_band": f"Band {overall_band}",
        "sub_scores": {
            "fluency_and_coherence": f"Band {fluency_band}",
            "lexical_resource": f"Band {lr_band}",
            "grammatical_range_accuracy": f"Band {gra_band}",
            "pronunciation_estimated": f"Band {pron_band}",
        },
        "vector_retrieval_references": {
            "nearest_fluency_matches": matched_fluency,
            "similar_content_samples": matched_content,
        },
        "deepseek_detailed_analysis": llm_lang_eval
    }
    if evaluation_warnings:
        report["evaluation_warnings"] = evaluation_warnings

    print(f"[Eval] finished time={time.time() - total_start:.2f}s")

    return report



def pause_sentence_advice(pauses_by_dimension: dict) -> dict:
    """
    Randomly selects up to 5 paused sentences from pauses_by_dimension 
    and calls the DeepSeek API to provide IELTS improvement advice.
    """
    # 1. Extract all pauses from the various dimensions
    all_pauses = []
    
    # Iterate through the dimension keys (e.g., 'mid_pause_100_200', 'filler_pause_100_250')
    for dim_name, dim_data in pauses_by_dimension.items():
        if isinstance(dim_data, dict) and "pauses" in dim_data:
            all_pauses.extend(dim_data["pauses"])
            
    # 2. Extract unique sentences to avoid analyzing the same sentence multiple times
    unique_sentences = list(set(
        pause.get("sentence_text") 
        for pause in all_pauses 
        if pause.get("sentence_text")
    ))
    
    if not unique_sentences:
        return {"feedback": [], "message": "No paused sentences detected."}

    # 3. Randomly select up to 5 sentences
    selected_sentences = random.sample(unique_sentences, min(5, len(unique_sentences)))

    # 4. Construct the DeepSeek Prompts
    system_prompt = """You are an expert IELTS examiner and English teacher. 
The candidate has produced the following sentences containing unnatural pauses, filler words, or hesitations.
Provide specific, actionable advice on how to improve the fluency, grammatical structure, and lexical resource of each sentence to achieve a higher band score. Keep the feedback constructive and concise.

Return ONLY a valid JSON object matching this exact structure:
{
  "pause_sentence_feedback": [
    {
      "original_sentence": "...",
      "improved_sentence": "...",
      "examiner_advice": "..."
    }
  ]
}
"""

    user_content = "Here are the candidate's sentences to analyze:\n"
    for i, sent in enumerate(selected_sentences, 5):
        user_content += f"{i}. {sent}\n"

    # 5. Call DeepSeek using the existing JSON wrapper
    # This automatically handles retries and JSON repairing
    print(f"\n🤖 Calling DeepSeek to analyze {len(selected_sentences)} paused sentences...")
    result = call_deepseek_json(system_prompt, user_content)
    
    return result



# ===========================================================================
# 使用示例 (Usage Example)
# ===========================================================================
if __name__ == "__main__":
    # 1. 检索指定目录下的所有 .wav 文件
    wav_files = list(INPUT_AUDIO_DIR.glob("*.wav")) + list(INPUT_AUDIO_DIR.glob("*.m4a"))

    if not wav_files:
        print(f"❌ 错误: 在 {INPUT_AUDIO_DIR} 文件夹下未找到任何 .wav 或 .m4a 文件！")
        sys.exit(1)

    print(f"🔍 检索到 {len(wav_files)} 个 .wav 或 .m4a 文件，准备开始批量处理...\n")

    # 2. 遍历处理每个音频文件
    for idx, audio_file in enumerate(wav_files, start=1):
        print("=" * 60)
        print(f"🎙️ [{idx}/{len(wav_files)}] 处理文件: {audio_file.name}")
        print("=" * 60)

        try:
            # [1/4] 音频转录与切词 (使用当前迭代的 audio_file)
            print(f"\n🎙️ [1/4] 开始对真实音频进行转录与切词: {audio_file.name}...")
            full_transcript, all_sentences = transcribe_and_split_sentences(audio_file)
            print(f"✅ 转录完成，共识别出 {len(all_sentences)} 个句子。")

            # [2/4] 分析停顿与计算语速特征
            print("\n📊 [2/4] 分析停顿与计算语速特征...")
            detected_pauses = detect_sentence_internal_pauses(all_sentences, threshold_ms=PAUSE_THRESHOLD_MS)
            classified_pauses = classify_candidate_pauses(detected_pauses)
            speaking_rate_info = compute_speaking_rate(all_sentences)
            fluency_features = build_fluency_features(speaking_rate_info, classified_pauses)

            # Generate the pauses_by_dimension dictionary
            filtered_pauses_data = build_filtered_pauses_json(
                band="Unknown", 
                source_name=audio_file.name, 
                features=fluency_features, 
                classified=classified_pauses
            )
            
            # Fetch advice for the paused sentences
            pause_advice = pause_sentence_advice(filtered_pauses_data["pauses_by_dimension"])
            print("📝 Pause Improvement Advice Generated.")

            print(f"  └─ 语速 (WPM): {fluency_features['speaking_rate_wpm']}")
            print(f"  └─ 原始6维流利度特征: {fluency_features['raw_values']}")
            print(f"  └─ 归一化6维流利度特征: {fluency_features['normalized_values']}")

            # [3/4] 角色格式化分段
            print("\n🤖 [3/4] 调用 DeepSeek 对文本进行 Q&A 角色格式化分段...")
            qa_data = format_qa_with_deepseek(full_transcript)
            candidate_turns = qa_data.get("turns", [])

            if not candidate_turns:
                print("⚠️ 未能提取出标准 Q&A Turns，将全文作为 Candidate 回答处理。")
                candidate_turns = [{"speaker": "Candidate", "type": "answer", "topic": "General", "text": full_transcript}]

            # [4/4] 综合评估
            print("\n📝 [4/4] 运行综合评估 (ChromaDB 向量比对 + DeepSeek 语法词汇评估)...")
            final_report = evaluate_ielts_candidate(
                candidate_turns=candidate_turns,
                fluency_features=fluency_features,
                full_transcript=full_transcript
            )

            print("\n" + "=" * 50)
            print(f"🎯 文件 [{audio_file.name}] 最终评估报告 JSON:")
            print("=" * 50)
            print(json.dumps(final_report, indent=2, ensure_ascii=False))

        except Exception as e:
            # 捕获单个文件的异常，避免单个文件报错导致整个批处理中断
            print(f"\n❌ 处理文件 {audio_file.name} 时发生错误: {str(e)}")
            continue
