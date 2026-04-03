# Alignment Report

**Date:** 2026-04-01  
**Scope:** PRD, UX Design Specification, Architecture, Epics/Stories  
**Status:** Aligned after reconciliation

## Purpose

This note fixes the implementation baseline across planning artifacts so the team does not carry multiple conflicting interpretations into delivery.

## Source Of Truth Decisions

1. **Primary transcription provider**
Soniox is the primary transcription provider for MVP.
`/upload` plain-text input is the operational fallback.
tldv may be used as an auxiliary source of links or exports, but not as the primary transcriber.

2. **Tracker interaction model**
The tracker has one slash command only: `/report <url>`.
All other tracker actions use inline buttons or Bot Menu.
This includes approve, edit, reject, agenda access, and status access.

3. **Approval and delivery model**
`approved` does not mean “already sent to the client”.
`approved` means “tracker confirmed the text and it is ready for manual forwarding”.
Actual delivery remains manual on MVP to preserve tracker control and confidentiality review.

4. **Trust calibration model**
The system should drop unsupported uncertain content by default.
At the same time, trust-calibration markers `[approximate]` and `[speaker_check]` remain valid in the first 2-3 weeks where the system has evidence but needs tracker verification.
The product does not use a “mark everything uncertain” strategy.

5. **F5 schedule**
MVP baseline is Monday morning.
Operational schedule: F5 at `Пн 8:00`, F4 at `Пн 9:00`, then F3-lite.
Friday timing remains a future experiment only if pilot response rates justify it.

6. **Reference layer**
Telegram is the action layer.
Docs/Sheets are the reference layer for long-form reading, history, and traceability.
This does not turn MVP into a separate product UI.

## Alignment Summary

### PRD

- Soniox is primary.
- Bot interaction is `/report` + inline-first flow.
- Manual delivery by tracker remains required on MVP.
- Trust markers remain part of the early adoption model.

### UX

- UX now matches inline-first bot behavior.
- F5 timing is Monday morning, not Friday.
- Trust model is consistent with early calibration markers and dropping unsupported content.

### Architecture

- Architecture now treats Soniox as primary and `/upload` as fallback.
- Telegram is defined as inline-first with `/report` as the only slash command.
- Delivery state model is compatible with manual forwarding.

### Epics and Stories

- Stories now implement Soniox-first planning.
- Slash command sprawl for approve/edit/reject/status is removed from the requirements model.
- Approval wording is aligned with manual delivery.
- F5 timing is aligned with PRD and architecture.

## Implementation Guardrails

- Do not reintroduce `tldv` as the primary provider in stories or technical docs.
- Do not add new slash commands for tracker actions unless the interaction model is deliberately changed.
- Do not collapse `approved` and `delivered` into one state.
- Do not move F5 to Friday without updating PRD, UX, architecture, and epics together.
- Do not remove `[approximate]` and `[speaker_check]` from early-pilot behavior unless the trust model is deliberately revised.

## Residual Open Questions

- Whether tldv should remain documented at all as an auxiliary export source, or be removed entirely later.
- Whether Friday F5 collection should be tested after pilot data exists.
- Whether trust markers should be disabled automatically after a defined confidence threshold, or only by manual configuration.

## Recommended Use

Use this file as the reconciliation reference during implementation reviews, story creation, and future planning edits.
