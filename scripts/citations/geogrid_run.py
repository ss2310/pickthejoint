"""Weekly AI citation run for Pick the Joint (Prompt 8), through the owner's GeoGrid tool.

Asks every approved question in data/citation-queries.json to the AI sources
GeoGrid's probe asks (ChatGPT, Gemini, Perplexity, Google AI Overviews, with the
routes set in GeoGrid's config/ai_engines.yaml) and writes one results file.
Upload that file at https://pickthejoint.com/admin/citations; Pick the Joint
decides there whether each answer cited pickthejoint.com and logs the cost.

It runs on the owner's computer with GeoGrid's own Python and keys. GeoGrid is
not changed and Pick the Joint never sees GeoGrid's keys. Answers are cached by
GeoGrid for 7 days, so a second run in the same week costs next to nothing.

Usage (from the Pick the Joint folder; the Python is GeoGrid's):

  "<GeoGrid>/.venv/Scripts/python" scripts/citations/geogrid_run.py --geogrid "<GeoGrid folder>" --dry-run
  "<GeoGrid>/.venv/Scripts/python" scripts/citations/geogrid_run.py --geogrid "<GeoGrid folder>" --max-cost 3

Exit codes: 0 done, 2 stopped at --max-cost (the file still holds what was asked), 1 failed.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
CITY_NAMES = {"indore": "Indore"}
COUNTRY = "in"


def load_questions(path: Path, city: str) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    by_locale = data.get(city) or {}
    out = []
    for locale in ("en", "hi"):
        for q in by_locale.get(locale) or []:
            out.append({"locale": locale, "query": q})
    if not out:
        raise SystemExit(f"no questions for city {city!r} in {path}")
    return out


def url_of(c) -> str | None:
    if isinstance(c, str):
        return c
    if isinstance(c, dict):
        return c.get("url") or c.get("link")
    return None


async def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--geogrid", default=os.environ.get("GEOGRID_DIR"), help="GeoGrid's folder (or set GEOGRID_DIR)")
    ap.add_argument("--city", default="indore")
    ap.add_argument("--questions", default=str(REPO / "data" / "citation-queries.json"))
    ap.add_argument("--out", default=None, help="results file (default: citation-runs/<run id>.json in this repo)")
    ap.add_argument("--max-cost", type=float, default=3.0, help="stop asking once this much USD is spent (default 3)")
    ap.add_argument("--max-tokens", type=int, default=500, help="longest answer asked for (default 500)")
    ap.add_argument("--dry-run", action="store_true", help="print the questions, sources and estimated cost; ask nothing")
    args = ap.parse_args()

    if not args.geogrid or not (Path(args.geogrid) / "geogrid" / "aimarket.py").exists():
        raise SystemExit("pass --geogrid <GeoGrid folder> (the folder that holds geogrid/aimarket.py)")
    geogrid_dir = Path(args.geogrid).resolve()
    questions = load_questions(Path(args.questions).resolve(), args.city)
    out_dir = REPO / "citation-runs"

    # GeoGrid reads its .env and config from its own folder.
    os.chdir(geogrid_dir)
    sys.path.insert(0, str(geogrid_dir))
    from geogrid import aimarket, costmeter, modes  # noqa: E402

    engines = modes.engines_for("probe")          # {label: model}, the probe's sources and routes
    city_name = CITY_NAMES.get(args.city, args.city.title())

    def estimate_for(model: str) -> float:
        if model == aimarket.AI_OVERVIEW_SOURCE:
            return costmeter.estimate("dataforseo", "serp/google/organic/live/advanced")
        if model.startswith(aimarket.DFS_LLM_PREFIX):
            platform = model.split(":")[1]
            return costmeter.estimate("dataforseo", f"ai_optimization/{platform}/llm_responses/live")
        return costmeter.estimate("openrouter", model)

    per_q = {label: estimate_for(model) for label, model in engines.items()}
    est = sum(per_q.values()) * len(questions)
    print(f"{len(questions)} questions x {len(engines)} sources; estimated at most ${est:.2f} "
          f"(less for answers GeoGrid cached in the last 7 days)")
    for label, model in engines.items():
        print(f"  {label:<22} {model:<45} ~${per_q[label]:.3f} a question")
    if args.dry_run:
        return 0

    asked_at = datetime.now(timezone.utc)
    run_id = f"geogrid-{args.city}-{asked_at.strftime('%Y%m%d-%H%M%S')}"
    cache = aimarket.AnswerCache(None, int(modes.config().get("ai_cache_days") or 7))
    meter = costmeter.CostMeter(max_cost=args.max_cost)
    sem = asyncio.Semaphore(6)

    async def ask(q: dict, label: str, model: str) -> dict:
        async with sem:
            try:
                if model == aimarket.AI_OVERVIEW_SOURCE:
                    res = await aimarket._overview_for(label, q["query"], city_name, COUNTRY, cache)
                else:
                    res = await aimarket._answers_for(label, model, q["query"], city_name, COUNTRY, 1, args.max_tokens, cache)
            except Exception as e:  # one failed check must not stop the run
                res = {"answers": [], "cost_usd": 0.0, "called": 0, "error": f"{type(e).__name__}: {e}"}
        answers = res.get("answers") or []
        a = answers[0] if answers else {}
        no_overview = bool(a.get("no_overview"))
        error = res.get("error") or (None if answers else "no answer")
        if no_overview:
            error = "Google showed no AI Overview for this search"
        return {
            "locale": q["locale"], "query": q["query"], "engine": label, "model": model,
            "answered": bool(answers) and not no_overview and not res.get("error"),
            "error": error, "text": (a.get("text") or "")[:8000],
            "citations": [u for u in (url_of(c) for c in (a.get("citations") or [])) if u],
            "cost_usd": round(float(res.get("cost_usd") or 0.0), 6), "cached": res.get("called", 1) == 0,
            "asked_at": a.get("asked_at"),
        }

    with costmeter.use(meter):
        costmeter.set_section("ptj_citations")
        cells = await asyncio.gather(*[ask(q, label, model) for q in questions for label, model in engines.items()])

    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=geogrid_dir, capture_output=True, text=True).stdout.strip()
    result = {
        "format": "ptj-citations/1", "run_id": run_id, "tool": f"geogrid {commit}".strip(), "city": args.city,
        "asked_at": asked_at.isoformat(timespec="seconds"), "engines": engines,
        "cost_usd": round(sum(c["cost_usd"] for c in cells), 6),
        "stopped": (f"max cost ${args.max_cost:.2f} reached" if meter.stopped else None),
        "cells": cells,
    }
    out = Path(args.out) if args.out else out_dir / f"{run_id}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    answered = sum(1 for c in cells if c["answered"])
    ours = sum(1 for c in cells if any("pickthejoint.com" in u for u in c["citations"]))
    print(f"{answered} of {len(cells)} checks answered; {ours} cite pickthejoint.com; cost ${result['cost_usd']:.4f}")
    if result["stopped"]:
        print(f"STOPPED: {result['stopped']}")
    print(f"results file: {out}")
    return 2 if meter.stopped else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
