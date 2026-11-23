-- Third-party risk (TPRM): the consultant's "extra waivers" are removed
-- (product decision, 22 Nov 2026; docs/tprm-v2-spec.md section 4k).
--
-- Migration 116 let a consultant waive the evidence of one further question
-- against an accepted SOC 2 report, with a note naming the report section
-- (tp_evidence_waivers). It saved the third party nothing, because the
-- evidence is required at submission anyway, so the feature is gone from the
-- domain, the routes, the review page, the AI review's input and the spec.
-- Everything else of the report waiver stays: the upload, the automatic
-- coverage, the consultant's accept or reject, SOC 2 exceptions and the
-- clarifications raised on a reject.
--
-- Only extra waivers used this table and its guard: no foreign key, view,
-- trigger or function elsewhere refers to it. The history stays where it was
-- always kept, in the assessments' event chains (tp_events,
-- evidence_waiver.added / evidence_waiver.withdrawn, with the question, the
-- note and the reason), which this migration does not touch. A question that
-- had an active extra waiver now shows its own evidence state again (provided,
-- covered by a report, asked for again or missing).
--
-- DROP TABLE removes the guard trigger with the table.

DROP TABLE IF EXISTS tp_evidence_waivers;
DROP FUNCTION IF EXISTS tp_evidence_waivers_guard_fn();
