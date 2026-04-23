# Corpora & Datasets

## Primary
- **GreenTalk Corpus**: 48 hours of spontaneous English speech recorded at Greenvale. Priya's main dataset for CALLIOPE.
  - Location: ~/research/calliope/data/greentalk/
  - Annotations: prosodic boundaries, discourse relations (in progress, 60% complete with old 3-tier scheme)
  - Note: Existing annotations need conversion to new 5-tier scheme

## Secondary/Reference
- **Penn Treebank**: Used for syntactic feature extraction
- **COCA (Corpus of Contemporary American English)**: Reference for lexical frequency norms
- **Switchboard**: Telephone speech corpus, used for baseline comparisons
- **LibriSpeech**: Clean read speech, used as contrastive corpus
- **BNC Spoken**: British English spoken corpus, license obtained February 2026. Used as secondary evaluation corpus for cross-variety generalisation testing. Model trained on GreenTalk (American English) transfers well for prosodic tiers (1-3) but struggles with discourse-prosodic tiers (4-5).

## Planned
- None currently pending