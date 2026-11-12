-- Claim numbers used to be "how many claims exist, plus one", so two claims
-- filed at the same moment picked the same number and one of them failed.
-- A sequence never hands out the same value twice, as for policy numbers.
--
-- It is owned by the claim number column, so it is dropped with the column
-- and reset by TRUNCATE ... RESTART IDENTITY (which the tests use).
CREATE SEQUENCE "claim_number_seq" OWNED BY "Claim"."claimNumber";

-- Carry on after the highest number already used (the digits after the last dash).
SELECT setval('"claim_number_seq"', GREATEST(filed.highest, 1), filed.highest > 0)
FROM (
  SELECT COALESCE(MAX(CAST(substring("claimNumber" FROM '(\d+)$') AS INTEGER)), 0) AS highest
  FROM "Claim"
) AS filed;
