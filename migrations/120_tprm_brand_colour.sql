-- Third-party risk (TPRM), premium upgrade Phase 1 (decision 6, 22 Nov 2026):
-- the firm's brand colour, the one accent of every TPRM screen, the vendor
-- pages and the report (docs/tprm-design-language.md). Migrations 088-119
-- are applied and frozen; this one adds one column only.
--
--   tp_letterheads.brand_colour  "#rrggbb", lower case, or NULL (the default
--                                deep navy #1f3a5f). The app also refuses a
--                                colour too light to carry white text
--                                (contrast with white at least 4.5:1,
--                                lib/tprm/letterhead.js); the database holds
--                                the shape only.
--
-- The time zone is not stored here: TPRM uses the firm's own time zone
-- (firms.timezone, System, Calendar timezone) and the client's override
-- (workspaces.timezone), like the rest of the app (Vijay, 22 Nov 2026).

ALTER TABLE tp_letterheads ADD COLUMN IF NOT EXISTS brand_colour text;
ALTER TABLE tp_letterheads DROP CONSTRAINT IF EXISTS tp_letterheads_brand_colour_shape;
ALTER TABLE tp_letterheads ADD CONSTRAINT tp_letterheads_brand_colour_shape
  CHECK (brand_colour IS NULL OR brand_colour ~ '^#[0-9a-f]{6}$');
