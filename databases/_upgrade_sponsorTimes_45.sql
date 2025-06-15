BEGIN TRANSACTION;

ALTER TABLE "sponsorTimes" ADD "cropLeft" INTEGER;
ALTER TABLE "sponsorTimes" ADD "cropRight" INTEGER;
ALTER TABLE "sponsorTimes" ADD "cropTop" INTEGER;
ALTER TABLE "sponsorTimes" ADD "cropBottom" INTEGER;

UPDATE "config" SET value = 45 WHERE key = 'version';

COMMIT;
