-- Third-party risk (TPRM) v2, Phase 5C: the firm's letterhead for the
-- client-facing recommendation report (docs/tprm-v2-spec.md section 4e).
-- Migrations 083-104 are applied and frozen; this one adds one table only and
-- replaces no function of an earlier migration.
--
-- The app had no firm-level branding (firms holds a name and a time zone;
-- workspaces.brand_* is the client's own branding), so the report's
-- letterhead gets its own table, one row per firm (no row: the firm's name
-- and nothing else). Managers edit it (tp.settings,
-- /tprm/settings/letterhead, lib/tprm/letterhead.js).
--
--   display_name   the firm's name as printed (empty: firms.name).
--   address_lines  up to 6 lines, newline separated.
--   contact_line   phone, e-mail or website, one line.
--   footer_text    printed at the foot of every page.
--   logo           the logo's bytes (PNG or JPEG, at most 1 MB), uploaded
--                  through the app's upload pipeline and kept here, not in the
--                  upload folder: no storage path to resolve or leak, and a
--                  database backup carries it. logo_mime / logo_sha256 /
--                  logo_size / logo_name describe it; all set or all null.
--
-- Separate from tp_firm_settings so a letterhead edit never makes the AI
-- review switch's form stale (each has its own row_version).

CREATE TABLE IF NOT EXISTS tp_letterheads (
  firm_id bigint PRIMARY KEY REFERENCES firms(id) ON DELETE CASCADE,
  display_name text CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  address_lines text CHECK (address_lines IS NULL OR (length(address_lines) BETWEEN 1 AND 600
    AND array_length(string_to_array(address_lines, E'\n'), 1) <= 6)),
  contact_line text CHECK (contact_line IS NULL OR length(contact_line) BETWEEN 1 AND 200),
  footer_text text CHECK (footer_text IS NULL OR length(footer_text) BETWEEN 1 AND 300),
  logo bytea,
  logo_mime text CHECK (logo_mime IS NULL OR logo_mime IN ('image/png', 'image/jpeg')),
  logo_sha256 text CHECK (logo_sha256 IS NULL OR logo_sha256 ~ '^[0-9a-f]{64}$'),
  logo_size integer CHECK (logo_size IS NULL OR logo_size BETWEEN 1 AND 1048576),
  logo_name text CHECK (logo_name IS NULL OR length(logo_name) BETWEEN 1 AND 255),
  updated_by bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  row_version integer NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CONSTRAINT tp_letterheads_logo_shape CHECK (
    (logo IS NULL AND logo_mime IS NULL AND logo_sha256 IS NULL AND logo_size IS NULL AND logo_name IS NULL)
    OR (logo IS NOT NULL AND logo_mime IS NOT NULL AND logo_sha256 IS NOT NULL AND logo_size IS NOT NULL
        AND logo_name IS NOT NULL AND octet_length(logo) = logo_size))
);
