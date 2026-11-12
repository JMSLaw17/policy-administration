-- Policy numbers used to be "how many policies exist, plus one", which gives
-- two policies issued at the same moment the same number. A sequence is a
-- counter that never hands out the same value twice.
--
-- It is owned by the policy number column, so it is dropped with the column
-- and reset by TRUNCATE ... RESTART IDENTITY (which the tests use).
CREATE SEQUENCE "policy_number_seq" OWNED BY "Policy"."policyNumber";

-- Carry on after the highest number already issued (the digits after the last dash).
SELECT setval('"policy_number_seq"', GREATEST(issued.highest, 1), issued.highest > 0)
FROM (
  SELECT COALESCE(MAX(CAST(substring("policyNumber" FROM '(\d+)$') AS INTEGER)), 0) AS highest
  FROM "Policy"
) AS issued;
