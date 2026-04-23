# CALLIOPE — Corpus Analysis of Linguistic and Prosodic Elements

## Overview
PhD dissertation project. Building a computational model that maps prosodic features (pitch contours, pause duration, speech rate) to discourse structure in spontaneous English speech.

## Current status (as of April 2026)
- Annotation phase: 60% complete on GreenTalk corpus (using old 3-tier scheme)
- Baseline model: Random forest classifier, F1=0.63 on dev set (for comparison)
- Main model: wav2vec2-base encoder with discourse-aware attention mechanism, F1=0.78 on dev set
- Next: Submit NAACL 2026 paper by April 28 deadline
- Funding: NSF supplemental grant (NSF-2431587) — $45K over 18 months

## Key files
- Model code: ~/research/calliope/src/
- Data: ~/research/calliope/data/greentalk/
- Results: ~/research/calliope/results/
- Draft chapters: ~/research/calliope/writing/
- Annotation manual: ~/research/calliope/docs/annotation_v2.md (5-tier scheme)

## Dependencies
- Praat (or parselmouth) for acoustic feature extraction
- Python: statsmodels.MixedLM, scipy for statistical analysis
- Polars for data manipulation (10x faster than pandas for grouped aggregations)
- HuggingFace (wav2vec2, transformers) for model architecture
- wandb for experiment tracking (project: calliope-experiments)

## Active corpora
- GreenTalk: primary training corpus (American English)
- BNC Spoken: secondary evaluation corpus (British English) — license obtained February 2026

## Key changes since January 2026
- Committee: Dr. Aldridge retired → replaced by Dr. Yuki Morimoto
- Tools: Switched from R/lme4 to Python/statsmodels/scipy; using Polars dataframes
- Annotation: 3-tier → 5-tier prosodic boundary system
- Model: Random forest → wav2vec2 + discourse-aware attention
- Funding: NSF DDIG rejected March 2025 → NSF supplemental approved March 2026
- Compute: Moved to disco-gpu01 (8x H100, dedicated linguistics/cogsci server)