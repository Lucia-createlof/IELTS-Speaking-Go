from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import asyncio
import json
import os
import re
import secrets
import shutil
import threading
import time
import certifi
import websockets
import os
from dotenv import load_dotenv

# 自动读取项目根目录下的 .env 文件
load_dotenv()

# 强制 Python 全局 SSL 使用 certifi 的 CA 根证书包
os.environ["SSL_CERT_FILE"] = certifi.where()
os.environ["REQUESTS_CA_BUNDLE"] = certifi.where()

from fastapi import (
    BackgroundTasks,
    FastAPI,
    File,
    Form,
    HTTPException,
    UploadFile,
    Response as FastAPIResponse,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

try:
    import analyze_part
    import core_engine
except ModuleNotFoundError as exc:
    if exc.name not in {"analyze_part", "core_engine"}:
        raise
    from src import analyze_part
    from src import core_engine

import dashscope
from dashscope.audio.tts_v2 import SpeechSynthesizer, AudioFormat


def _env_int(name: str, default: int, minimum: int = 0) -> int:
    value = os.getenv(name, "").strip()
    if not value:
        return default
    try:
        return max(int(value), minimum)
    except ValueError:
        print(f"[Config] {name} is not an integer; using {default}.")
        return default


def _configure_dashscope() -> dict[str, str | None]:
    api_key = os.getenv("DASHSCOPE_API_KEY", "").strip()
    region = os.getenv("DASHSCOPE_REGION", "beijing").strip().lower()
    workspace = os.getenv("DASHSCOPE_WORKSPACE_ID", "").strip() or None

    region_hosts = {
        "singapore": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
        "sg": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
        "ap-southeast-1": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
        "international": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
        "intl": (
            "dashscope-intl.aliyuncs.com",
            "ap-southeast-1.maas.aliyuncs.com",
        ),
        "beijing": (
            "dashscope.aliyuncs.com",
            "cn-beijing.maas.aliyuncs.com",
        ),
        "cn-beijing": (
            "dashscope.aliyuncs.com",
            "cn-beijing.maas.aliyuncs.com",
        ),
    }
    region_config = region_hosts.get(region)
    if not region_config:
        raise RuntimeError(
            f"Unsupported DASHSCOPE_REGION={region!r}. "
            "Use singapore or beijing."
        )
    public_host, workspace_suffix = region_config

    websocket_url = os.getenv("DASHSCOPE_BASE_WEBSOCKET_API_URL", "").strip()
    if not websocket_url:
        endpoint_host = (
            f"{workspace}.{workspace_suffix}" if workspace else public_host
        )
        websocket_url = f"wss://{endpoint_host}/api-ws/v1/inference"

    http_url = os.getenv("DASHSCOPE_BASE_HTTP_API_URL", "").strip()
    if not http_url:
        endpoint_host = (
            f"{workspace}.{workspace_suffix}" if workspace else public_host
        )
        http_url = f"https://{endpoint_host}/api/v1"

    dashscope.api_key = api_key or None
    dashscope.base_websocket_api_url = websocket_url
    dashscope.base_http_api_url = http_url

    print(
        "[DashScope] "
        f"region={region}, "
        f"model={os.getenv('DASHSCOPE_TTS_MODEL', 'cosyvoice-v3-flash')}, "
        f"websocket={websocket_url}, "
        f"workspace={'configured' if workspace else 'default'}, "
        f"api_key={'configured' if api_key else 'missing'}"
    )
    return {
        "region": region,
        "workspace": workspace,
        "websocket_url": websocket_url,
        "http_url": http_url,
        "api_key": api_key,
    }


DASHSCOPE_CONFIG = _configure_dashscope()
DASHSCOPE_TTS_MODEL = os.getenv("DASHSCOPE_TTS_MODEL", "cosyvoice-v3-flash").strip()
DASHSCOPE_TTS_VOICE = os.getenv("DASHSCOPE_TTS_VOICE", "longanyang").strip()
DASHSCOPE_TTS_RETRIES = _env_int("DASHSCOPE_TTS_RETRIES", 3, minimum=1)
DASHSCOPE_TTS_TIMEOUT_MS = _env_int("DASHSCOPE_TTS_TIMEOUT_MS", 120_000, minimum=1)

app = FastAPI(title="IELTS Speaking Mock AI")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[],
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _find_project_paths() -> tuple[Path, Path]:
    candidates = [Path(__file__).resolve().parent]
    if candidates[0].parent not in candidates:
        candidates.append(candidates[0].parent)

    for candidate in candidates:
        questions_dir = candidate / "questions"
        if questions_dir.is_dir():
            return candidate, questions_dir
        questions_dir = candidate / "data" / "questions"
        if questions_dir.is_dir():
            return candidate, questions_dir

    project_root = candidates[0]
    return project_root, project_root / "questions"


PROJECT_ROOT, QUESTIONS_DIR = _find_project_paths()
UPLOAD_DIR = PROJECT_ROOT / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")
HISTORY_PATH = PROJECT_ROOT / "practice_history.json"
AUTH_COOKIE_NAME = "ielts_mockai_session"
AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
LOGIN_CODES: dict[str, dict] = {}
LOGIN_SESSIONS: dict[str, dict] = {}
MOCK_ANALYSIS_JOBS: dict[str, dict] = {}
MOCK_ANALYSIS_JOBS_LOCK = threading.Lock()
MOCK_ANALYSIS_JOB_LIMIT = 100
QUESTION_NUMBER_RE = re.compile(
    r"^\s*(?:question\s*)?\d+[\).\u3001:：-]\s*",
    re.IGNORECASE,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_history() -> list[dict]:
    if not HISTORY_PATH.exists():
        return []
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except json.JSONDecodeError:
        return []


def _save_history_record(record: dict) -> dict:
    history = _load_history()
    stored = {"id": str(uuid4()), "created_at": _utc_now(), **record}
    history.insert(0, stored)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history[:200], f, ensure_ascii=False, indent=2)
    return stored


def _analysis_log(message: str) -> None:
    print(message, flush=True)


def _safe_error_message(exc: Exception) -> str:
    return str(exc).encode("ascii", "ignore").decode("ascii") or type(exc).__name__


def _prune_mock_analysis_jobs_locked() -> None:
    if len(MOCK_ANALYSIS_JOBS) <= MOCK_ANALYSIS_JOB_LIMIT:
        return

    terminal_jobs = sorted(
        (
            (job_id, job)
            for job_id, job in MOCK_ANALYSIS_JOBS.items()
            if job.get("status") in {"success", "failed"}
        ),
        key=lambda item: item[1].get("created_at", ""),
    )
    while len(MOCK_ANALYSIS_JOBS) > MOCK_ANALYSIS_JOB_LIMIT and terminal_jobs:
        job_id, _ = terminal_jobs.pop(0)
        MOCK_ANALYSIS_JOBS.pop(job_id, None)


def _register_mock_analysis_job(job_id: str) -> None:
    with MOCK_ANALYSIS_JOBS_LOCK:
        MOCK_ANALYSIS_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "created_at": _utc_now(),
        }
        _prune_mock_analysis_jobs_locked()


def _update_mock_analysis_job(job_id: str, **updates: object) -> None:
    with MOCK_ANALYSIS_JOBS_LOCK:
        job = MOCK_ANALYSIS_JOBS.get(job_id)
        if job is not None:
            job.update(updates)


def _run_mock_analysis_job(
    job_id: str,
    temp_audio_path: Path,
    question_text: str,
    part: str,
    topic: str,
) -> None:
    started = time.perf_counter()
    _update_mock_analysis_job(job_id, status="processing", started_at=_utc_now())
    _analysis_log(
        "[API /api/process-audio] job started "
        f"job_id={job_id} path={temp_audio_path}"
    )

    try:
        report = core_engine.run_pipeline(temp_audio_path, question_text)
        audio_url = _audio_url(temp_audio_path)
        history_record = _save_history_record(
            {
                "mode": "mock_test",
                "part": part,
                "topic": topic,
                "question_text": question_text,
                "audio_url": audio_url,
                "report": report,
            }
        )
        result = {
            "status": "success",
            "job_id": job_id,
            "report": report,
            "audio_url": audio_url,
            "history_record": history_record,
        }
        _update_mock_analysis_job(
            job_id,
            status="success",
            completed_at=_utc_now(),
            result=result,
        )
        _analysis_log(
            "[API /api/process-audio] job complete "
            f"job_id={job_id} time={time.perf_counter() - started:.2f}s"
        )
    except Exception as exc:
        if temp_audio_path.exists():
            temp_audio_path.unlink()
        error_message = _safe_error_message(exc)
        _update_mock_analysis_job(
            job_id,
            status="failed",
            completed_at=_utc_now(),
            error=error_message,
        )
        _analysis_log(
            "[API /api/process-audio][ERROR] job failed "
            f"job_id={job_id} time={time.perf_counter() - started:.2f}s "
            f"type={type(exc).__name__} error={error_message}"
        )


def _stored_audio_path(filename: str | None) -> Path:
    safe_name = Path(filename or "recording.m4a").name
    return UPLOAD_DIR / f"{uuid4().hex}-{safe_name}"


def _audio_url(audio_path: Path) -> str:
    return f"/uploads/{audio_path.name}"


def _normalize_phone(phone: str | None) -> str:
    return re.sub(r"\D", "", phone or "")


def _login_session(phone: str, token: str) -> dict:
    return {
        "phone": phone,
        "token": token,
        "logged_in_at": _utc_now(),
    }


def _question_file_path(part: str) -> Path:
    normalized = part.lower().replace(".json", "")
    target_path = QUESTIONS_DIR / f"{normalized}.json"
    if not target_path.exists():
        print(f"[PATH DEBUG] 文件未找到！尝试访问的绝对路径为: {target_path}")
    return target_path


def _spoken_question_text(text: str) -> str:
    return QUESTION_NUMBER_RE.sub("", text or "").strip()


def _synthesize_speech(text: str) -> Response:
    spoken_text = _spoken_question_text(text)
    if not spoken_text:
        spoken_text = text.strip() if text else "Please read the question."

    clean_text = re.sub(r'[\r\n\t]', ' ', spoken_text).strip()
    if not clean_text:
        raise HTTPException(status_code=400, detail="Text cannot be empty")
    if not DASHSCOPE_CONFIG["api_key"]:
        raise HTTPException(
            status_code=503,
            detail="DASHSCOPE_API_KEY is not configured on the server.",
        )

    last_exception: Exception | None = None
    for attempt in range(1, DASHSCOPE_TTS_RETRIES + 1):
        synthesizer = None
        try:
            synthesizer = SpeechSynthesizer(
                model=DASHSCOPE_TTS_MODEL,
                voice=DASHSCOPE_TTS_VOICE,
                format=AudioFormat.MP3_22050HZ_MONO_256KBPS,
                workspace=DASHSCOPE_CONFIG["workspace"],
                url=DASHSCOPE_CONFIG["websocket_url"],
            )

            result = synthesizer.call(
                clean_text,
                timeout_millis=DASHSCOPE_TTS_TIMEOUT_MS,
            )

            if isinstance(result, bytes):
                audio_data = result
            elif isinstance(result, bytearray):
                audio_data = bytes(result)
            elif hasattr(result, "get_audio_data"):
                audio_data = result.get_audio_data()
            elif hasattr(result, "output") and isinstance(result.output, (bytes, bytearray)):
                audio_data = bytes(result.output)
            else:
                audio_data = None

            if not audio_data:
                raise RuntimeError("CosyVoice returned empty audio data")

            print(f"[TTS Success] 成功生成音频，数据大小: {len(audio_data)} bytes")
            return Response(
                content=audio_data,
                media_type="audio/mpeg",
                headers={
                    "Cache-Control": "no-store",
                    "Content-Length": str(len(audio_data)),
                    "Accept-Ranges": "bytes",
                },
            )
        except Exception as exc:
            last_exception = exc
            err_msg = str(exc).encode("ascii", "ignore").decode("ascii")
            request_id = None
            if synthesizer is not None and hasattr(synthesizer, "get_last_request_id"):
                request_id = synthesizer.get_last_request_id()
            print(
                f"[TTS Warning] attempt={attempt}/{DASHSCOPE_TTS_RETRIES}, "
                f"endpoint={DASHSCOPE_CONFIG['websocket_url']}, "
                f"request_id={request_id or '-'}, error={err_msg}"
            )
            if attempt < DASHSCOPE_TTS_RETRIES:
                time.sleep(min(2.0, 0.5 * attempt))
        finally:
            if synthesizer is not None and hasattr(synthesizer, "close"):
                try:
                    synthesizer.close()
                except Exception:
                    pass

    final_err_msg = str(last_exception).encode("ascii", "ignore").decode("ascii")
    raise HTTPException(
        status_code=502,
        detail=(
            "CosyVoice upstream request failed. "
            f"endpoint={DASHSCOPE_CONFIG['websocket_url']}; error={final_err_msg}"
        ),
    ) from last_exception


@app.get("/")
async def root():
    return {"status": "ok", "service": "IELTS Speaking Mock AI"}


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "tts": {
            "provider": "dashscope",
            "region": DASHSCOPE_CONFIG["region"],
            "model": DASHSCOPE_TTS_MODEL,
            "voice": DASHSCOPE_TTS_VOICE,
            "websocket_url": DASHSCOPE_CONFIG["websocket_url"],
            "api_key_configured": bool(DASHSCOPE_CONFIG["api_key"]),
        },
    }

@app.get("/api/questions/{part}")
async def get_questions(part: str):
    file_path = _question_file_path(part)
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Part not found")
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


@app.post("/api/tts")
def text_to_speech(payload: dict):
    return _synthesize_speech(payload.get("text", ""))


@app.get("/api/tts")
def text_to_speech_get(text: str = ""):
    return _synthesize_speech(text)


@app.post("/api/auth/send-code")
async def send_login_code(payload: dict):
    phone = _normalize_phone(payload.get("phone"))
    if len(phone) < 10 or len(phone) > 15:
        raise HTTPException(status_code=400, detail="Invalid phone number")

    code = f"{secrets.randbelow(1_000_000):06d}"
    LOGIN_CODES[phone] = {
        "code": code,
        "created_at": datetime.now(timezone.utc).timestamp(),
    }
    print(f"[AUTH] Login code for {phone}: {code}")
    return {
        "status": "success",
        "message": "Verification code generated.",
        "dev_code": code,
    }


@app.post("/api/auth/login")
async def phone_code_login(payload: dict, response: FastAPIResponse):
    phone = _normalize_phone(payload.get("phone"))
    code = str(payload.get("code") or "").strip()
    stored = LOGIN_CODES.get(phone)
    now = datetime.now(timezone.utc).timestamp()

    if len(phone) < 10 or len(phone) > 15:
        raise HTTPException(status_code=400, detail="Invalid phone number")
    if not stored or stored.get("code") != code:
        raise HTTPException(status_code=401, detail="Invalid verification code")
    if now - float(stored.get("created_at", 0)) > 300:
        raise HTTPException(status_code=401, detail="Verification code expired")

    token = secrets.token_urlsafe(32)
    session = _login_session(phone, token)
    LOGIN_SESSIONS[token] = session
    LOGIN_CODES.pop(phone, None)
    response.set_cookie(
        key=AUTH_COOKIE_NAME,
        value=token,
        max_age=AUTH_MAX_AGE_SECONDS,
        httponly=False,
        samesite="lax",
        secure=False,
    )
    return {
        "status": "success",
        "session": session,
    }


@app.post("/api/auth/logout")
async def logout(response: FastAPIResponse):
    response.delete_cookie(AUTH_COOKIE_NAME)
    return {"status": "success"}


@app.post("/api/process-audio")
async def process_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    question_text: str = Form(...),
    enable_retrieve: str = Form("true"),
    part: str = Form("full_test"),
    topic: str = Form("IELTS Mock Test"),
    async_analysis: str = Form("false"),
):
    request_started = time.perf_counter()
    temp_audio_path = _stored_audio_path(file.filename)
    _analysis_log(
        "[API /api/process-audio] start "
        f"file={file.filename!r} part={part!r} "
        f"topic={topic!r} question_chars={len(question_text or '')} "
        f"enable_retrieve={enable_retrieve!r} async_analysis={async_analysis!r}"
    )
    try:
        with open(temp_audio_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        _analysis_log(
            "[API /api/process-audio] upload saved "
            f"path={temp_audio_path} bytes={temp_audio_path.stat().st_size}"
        )

        if async_analysis.strip().lower() in {"1", "true", "yes", "on"}:
            job_id = uuid4().hex
            _register_mock_analysis_job(job_id)
            background_tasks.add_task(
                _run_mock_analysis_job,
                job_id,
                temp_audio_path,
                question_text,
                part,
                topic,
            )
            _analysis_log(
                "[API /api/process-audio] job accepted "
                f"job_id={job_id} time={time.perf_counter() - request_started:.2f}s"
            )
            return JSONResponse(
                status_code=202,
                content={
                    "status": "processing",
                    "job_id": job_id,
                },
            )

        report = await asyncio.to_thread(
            core_engine.run_pipeline,
            temp_audio_path,
            question_text,
        )
        _analysis_log(
            "[API /api/process-audio] pipeline complete "
            f"time={time.perf_counter() - request_started:.2f}s"
        )
        audio_url = _audio_url(temp_audio_path)
        history_record = _save_history_record(
            {
                "mode": "mock_test",
                "part": part,
                "topic": topic,
                "question_text": question_text,
                "audio_url": audio_url,
                "report": report,
            }
        )

        return {
            "status": "success",
            "report": report,
            "audio_url": audio_url,
            "history_record": history_record,
        }
    except Exception as exc:
        if temp_audio_path.exists():
            temp_audio_path.unlink()
        err_msg = _safe_error_message(exc)
        _analysis_log(
            "[API /api/process-audio][ERROR] "
            f"time={time.perf_counter() - request_started:.2f}s "
            f"type={type(exc).__name__} error={err_msg}"
        )
        raise HTTPException(status_code=500, detail=err_msg) from exc


@app.get("/api/process-audio/jobs/{job_id}")
async def process_audio_job(job_id: str):
    with MOCK_ANALYSIS_JOBS_LOCK:
        job = MOCK_ANALYSIS_JOBS.get(job_id)
        snapshot = dict(job) if job is not None else None

    if snapshot is None:
        raise HTTPException(status_code=404, detail="分析任务不存在或已过期")

    if snapshot.get("status") == "success":
        return snapshot["result"]

    response = {
        "status": snapshot.get("status", "processing"),
        "job_id": job_id,
    }
    if snapshot.get("error"):
        response["error"] = snapshot["error"]
    return response


@app.post("/api/analyze-part")
async def analyze_part_audio(
    file: UploadFile = File(...),
    question_text: str = Form(...),
    part: str = Form("part1"),
    topic: str = Form(""),
):
    temp_audio_path = _stored_audio_path(file.filename)
    try:
        with open(temp_audio_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        analysis = analyze_part.run_part_analysis(
            temp_audio_path,
            question_text=question_text,
            part=part,
            topic=topic,
        )
        audio_url = _audio_url(temp_audio_path)
        history_record = _save_history_record(
            {
                "mode": "part_practice",
                "part": part,
                "topic": topic,
                "question_text": question_text,
                "audio_url": audio_url,
                "analysis": analysis,
            }
        )

        return {
            "status": "success",
            "analysis": analysis,
            "audio_url": audio_url,
            "history_record": history_record,
        }
    except Exception as exc:
        if temp_audio_path.exists():
            temp_audio_path.unlink()
        # ✅ 核心修改：利用你提供的逻辑，强制转为 ASCII 安全字符串打印，防止终端崩溃
        err_msg = str(exc).encode('ascii', 'ignore').decode('ascii')
        raise HTTPException(status_code=500, detail=err_msg) from exc


@app.get("/api/practice-history")
async def practice_history():
    return {"status": "success", "history": _load_history()}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
