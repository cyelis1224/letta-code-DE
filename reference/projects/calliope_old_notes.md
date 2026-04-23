# CALLIOPE — Early Planning Notes (ARCHIVED)

*This file has been archived for historical reference. All decisions listed below have been superseded by current project state.*

## Original Proposal Ideas
- Original idea: Map prosodic features to RST (Rhetorical Structure Theory) relations
- Decided against RST in favor of SDRT (Segmented Discourse Representation Theory) after committee feedback (Oct 2024)

## Baseline Evolution
- Original baseline: SVM classifier
- Switched to Random Forest after poor SVM results (Dec 2024)
- Current model: wav2vec2 encoder with discourse-aware attention, F1=0.78

## Corpus Selection
- Considered using Switchboard exclusively
- Beaumont pushed for recording a local corpus (became GreenTalk)

## Funding History
- Applied for NSF DDIG, rejected March 2025
- Current funding: NSF supplemental to Tanaka's grant (NSF-2431587), $45K/18mo, approved March 2026