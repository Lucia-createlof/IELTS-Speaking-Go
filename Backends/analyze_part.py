from __future__ import annotations

from pathlib import Path
import time
try:
    from retrieve import (
        PAUSE_THRESHOLD_MS,
        ASR_MODEL,
        build_filtered_pauses_json,
        build_fluency_features,
        classify_candidate_pauses,
        compute_speaking_rate,
        detect_sentence_internal_pauses,
        format_qa_with_deepseek,
        analyze_sentence_grammar_errors,
        transcribe_and_split_sentences,
        pause_sentence_advice,
    )
except ModuleNotFoundError as exc:
    if exc.name != "retrieve":
        raise
    from src.retrieve import (
        PAUSE_THRESHOLD_MS,
        ASR_MODEL,
        build_filtered_pauses_json,
        build_fluency_features,
        classify_candidate_pauses,
        compute_speaking_rate,
        detect_sentence_internal_pauses,
        format_qa_with_deepseek,
        analyze_sentence_grammar_errors,
        transcribe_and_split_sentences,
        pause_sentence_advice,
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


def run_part_analysis(
    audio_path: str | Path,
    question_text: str = "",
    part: str = "",
    topic: str = "",
) -> dict:

    total_start = time.time()
    print("\n====== ANALYSIS START ======")

    # ==========================
    # 1. ASR transcription
    # ==========================
    t = time.time()

    full_transcript, all_sentences = (
        transcribe_and_split_sentences(
            audio_path
        )
    )

    print(
        f"[TIME] {ASR_MODEL} + split: "
        f"{time.time()-t:.2f}s"
    )

    if not all_sentences:
        return {
            "error":
            "No valid speech detected. Please try again."
        }

    # ==========================
    # 2. Pause analysis
    # ==========================
    t = time.time()

    detected_pauses = (
        detect_sentence_internal_pauses(
            all_sentences,
            threshold_ms=PAUSE_THRESHOLD_MS
        )
    )

    classified_pauses = (
        classify_candidate_pauses(
            detected_pauses
        )
    )

    speaking_rate_info = (
        compute_speaking_rate(
            all_sentences
        )
    )

    fluency_features = (
        build_fluency_features(
            speaking_rate_info,
            classified_pauses
        )
    )

    pause_json = (
        build_filtered_pauses_json(
            band="Unscored",
            source_name=Path(audio_path).name,
            features=fluency_features,
            classified=classified_pauses,
        )
    )

    print(
        f"[TIME] audio metrics: "
        f"{time.time()-t:.2f}s"
    )

    # ==========================
    # 3. DeepSeek formatting
    # ==========================
    t = time.time()
    semantic_segments = []

    try:
        qa_data = format_qa_with_deepseek(
            full_transcript
        )
        semantic_segments = (
            qa_data.get("turns")
            or []
        )
        print("[DeepSeek QA] success")
    except Exception as e:
        print("[DeepSeek QA] skipped:", e)

    # fallback
    if not semantic_segments:
        semantic_segments = [
            {
                "speaker": "Candidate",
                "type": "answer",
                "topic": topic or question_text or "Part practice",
                "text": full_transcript,
            }
        ]

    print(
        f"[TIME] DeepSeek QA: "
        f"{time.time()-t:.2f}s"
    )

    # ==========================
    # 4. DeepSeek Pause Advice
    # ==========================
    t = time.time()
    pause_advice = {}

    try:
        pause_advice = pause_sentence_advice(
            pause_json.get(
                "pauses_by_dimension",
                {}
            )
        )
        print("[DeepSeek Advice] success")
    except Exception as e:
        print("[DeepSeek Advice] skipped:", e)
        pause_advice = {
            "feedback": [],
            "error": str(e)
        }

    print(
        f"[TIME] DeepSeek Advice: "
        f"{time.time()-t:.2f}s"
    )

    # ==========================
    # 5. DeepSeek Grammar Table
    # ==========================
    t = time.time()
    sentence_summaries = _sentence_summary(
        all_sentences
    )
    grammar_error_report = {
        "grammar_errors": []
    }

    try:
        grammar_error_report = (
            analyze_sentence_grammar_errors(
                sentence_summaries
            )
        )
        print("[DeepSeek Grammar] success")
    except Exception as e:
        print("[DeepSeek Grammar] skipped:", e)
        grammar_error_report = {
            "grammar_errors": [],
            "error": str(e)
        }

    print(
        f"[TIME] DeepSeek Grammar: "
        f"{time.time()-t:.2f}s"
    )

    # ==========================
    # result
    # ==========================
    result = {
        "mode": "part_practice",
        "part": part,
        "topic": topic,
        "question_text": question_text,
        "full_transcript": full_transcript,
        "semantic_segments": semantic_segments,
        "sentences": sentence_summaries,
        "speaking_rate": speaking_rate_info,
        "pause_analysis": pause_json,
        "pause_advice": pause_advice,
        "pause_sentence_advice": pause_advice,
        "grammar_error_report": grammar_error_report,
        "grammar_errors": grammar_error_report.get(
            "grammar_errors",
            []
        ),
        "detected_pause_count": len(detected_pauses),
        "classified_pause_counts": {
            "mid_counts": classified_pauses.get(
                "mid_counts",
                {}
            ),
            "filler_counts": classified_pauses.get(
                "filler_counts",
                {}
            ),
            "ignored_lt_100_count": classified_pauses.get(
                "ignored_lt_100_count",
                0
            ),
        },
    }

    print(f"[TOTAL TIME] {time.time()-total_start:.2f}s")
    print("====== ANALYSIS END ======\n")
    return result
