from pathlib import Path
from time import perf_counter
# 从你的 retrieve.py 导入核心函数
try:
    from retrieve import (
        transcribe_and_split_sentences,
        detect_sentence_internal_pauses,
        classify_candidate_pauses,
        compute_speaking_rate,
        build_fluency_features,
        build_filtered_pauses_json,
        format_qa_with_deepseek,
        analyze_sentence_grammar_errors,
        evaluate_ielts_candidate,
        pause_sentence_advice,
        PAUSE_THRESHOLD_MS,
    )
except ModuleNotFoundError as exc:
    if exc.name != "retrieve":
        raise
    from src.retrieve import (
        transcribe_and_split_sentences,
        detect_sentence_internal_pauses,
        classify_candidate_pauses,
        compute_speaking_rate,
        build_fluency_features,
        build_filtered_pauses_json,
        format_qa_with_deepseek,
        analyze_sentence_grammar_errors,
        evaluate_ielts_candidate,
        pause_sentence_advice,
        PAUSE_THRESHOLD_MS,
    )


def _sentence_summary(all_sentences: list[dict]) -> list[dict]:
    summaries = []
    for index, sentence in enumerate(all_sentences, start=1):
        words = sentence.get("words", [])
        summaries.append(
            {
                "sentence_index": index,
                "sentence_text": sentence.get("sentence_text", ""),
                "start_s": round(words[0]["start"], 3) if words else None,
                "end_s": round(words[-1]["end"], 3) if words else None,
                "word_count": len(words),
            }
        )
    return summaries


def run_pipeline(audio_path: Path, current_question: str) -> dict:
    total_start = perf_counter()
    pipeline_warnings: list[str] = []
    print(
        "[Mock] start "
        f"audio={audio_path} question_chars={len(current_question or '')}"
    )

    # 1. Speech-to-text and sentence splitting.
    stage_start = perf_counter()
    full_transcript, all_sentences = transcribe_and_split_sentences(audio_path)
    print(
        "[Mock] transcription done "
        f"sentences={len(all_sentences)} "
        f"transcript_chars={len(full_transcript)} "
        f"time={perf_counter() - stage_start:.2f}s"
    )

    if not all_sentences:
        print("[Mock][WARN] no valid speech detected")
        return {"error": "未检测到有效语音，请重试。"}

    # 2. Pause and fluency feature extraction.
    stage_start = perf_counter()
    detected_pauses = detect_sentence_internal_pauses(
        all_sentences,
        threshold_ms=PAUSE_THRESHOLD_MS,
    )
    classified_pauses = classify_candidate_pauses(detected_pauses)
    speaking_rate_info = compute_speaking_rate(all_sentences)
    fluency_features = build_fluency_features(
        speaking_rate_info,
        classified_pauses,
    )
    pause_json = build_filtered_pauses_json(
        band="Unscored",
        source_name=Path(audio_path).name,
        features=fluency_features,
        classified=classified_pauses,
    )
    print(
        "[Mock] audio metrics done "
        f"pauses={len(detected_pauses)} "
        f"wpm={speaking_rate_info.get('words_per_minute_wpm', 0)} "
        f"time={perf_counter() - stage_start:.2f}s"
    )

    pause_advice = {"feedback": []}
    try:
        stage_start = perf_counter()
        pause_advice = pause_sentence_advice(
            pause_json.get("pauses_by_dimension", {})
        )
        print(
            "[Mock] pause advice done "
            f"time={perf_counter() - stage_start:.2f}s"
        )
    except Exception as exc:
        warning = f"pause advice failed: {type(exc).__name__}: {exc}"
        print(f"[Mock][WARN] {warning}")
        pipeline_warnings.append(warning)
        pause_advice = {"feedback": [], "error": str(exc)}

    sentence_summaries = _sentence_summary(all_sentences)
    grammar_error_report = {"grammar_errors": []}
    try:
        stage_start = perf_counter()
        grammar_error_report = analyze_sentence_grammar_errors(
            sentence_summaries
        )
        print(
            "[Mock] grammar analysis done "
            f"time={perf_counter() - stage_start:.2f}s"
        )
    except Exception as exc:
        warning = f"grammar analysis failed: {type(exc).__name__}: {exc}"
        print(f"[Mock][WARN] {warning}")
        pipeline_warnings.append(warning)
        grammar_error_report = {"grammar_errors": [], "error": str(exc)}

    # 3. DeepSeek Q&A role identification.
    qa_data: dict = {}
    try:
        stage_start = perf_counter()
        qa_data = format_qa_with_deepseek(full_transcript)
        if not isinstance(qa_data, dict):
            qa_data = {}
        print(
            "[Mock] QA formatting done "
            f"turns={len(qa_data.get('turns') or [])} "
            f"time={perf_counter() - stage_start:.2f}s"
        )
    except Exception as exc:
        warning = f"QA formatting failed: {type(exc).__name__}: {exc}"
        print(f"[Mock][WARN] {warning}")
        pipeline_warnings.append(warning)
        qa_data = {}

    candidate_turns = qa_data.get("turns", [])
    if not candidate_turns:
        candidate_turns = [
            {
                "speaker": "Candidate",
                "type": "answer",
                "topic": current_question or "Mock test",
                "text": full_transcript,
            }
        ]
        print("[Mock] QA fallback candidate turn used")

    # 4. Chroma retrieval, rule matching, and DeepSeek scoring.
    try:
        stage_start = perf_counter()
        report = evaluate_ielts_candidate(
            candidate_turns=candidate_turns,
            fluency_features=fluency_features,
            full_transcript=full_transcript,
        )
        print(
            "[Mock] final evaluation done "
            f"time={perf_counter() - stage_start:.2f}s"
        )
    except Exception as exc:
        warning = f"final evaluation failed: {type(exc).__name__}: {exc}"
        print(f"[Mock][ERROR] {warning}")
        pipeline_warnings.append(warning)
        report = {
            "overall_band": "Unavailable",
            "sub_scores": {
                "fluency_and_coherence": "Unavailable",
                "lexical_resource": "Unavailable",
                "grammatical_range_accuracy": "Unavailable",
                "pronunciation_estimated": "Unavailable",
            },
            "vector_retrieval_references": {
                "nearest_fluency_matches": [],
                "similar_content_samples": [],
            },
            "deepseek_detailed_analysis": {"error": str(exc)},
        }

    report.update(
        {
            "full_transcript": full_transcript,
            "sentences": sentence_summaries,
            "speaking_rate": speaking_rate_info,
            "pause_analysis": pause_json,
            "pause_advice": pause_advice,
            "pause_sentence_advice": pause_advice,
            "grammar_error_report": grammar_error_report,
            "grammar_errors": grammar_error_report.get("grammar_errors", []),
            "detected_pause_count": len(detected_pauses),
            "classified_pause_counts": {
                "mid_counts": classified_pauses.get("mid_counts", {}),
                "filler_counts": classified_pauses.get("filler_counts", {}),
                "ignored_lt_100_count": classified_pauses.get("ignored_lt_100_count", 0),
            },
        }
    )
    if pipeline_warnings:
        report["pipeline_warnings"] = pipeline_warnings

    print(
        "[Mock] finished "
        f"time={perf_counter() - total_start:.2f}s "
        f"warnings={len(pipeline_warnings)}"
    )

    return report
