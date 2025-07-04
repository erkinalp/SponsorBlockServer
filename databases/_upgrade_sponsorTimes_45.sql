BEGIN TRANSACTION;

ALTER TABLE "sponsorTimes" ADD "cropLeft" INTEGER;
ALTER TABLE "sponsorTimes" ADD "cropRight" INTEGER;
ALTER TABLE "sponsorTimes" ADD "cropTop" INTEGER;
ALTER TABLE "sponsorTimes" ADD "cropBottom" INTEGER;

ALTER TABLE "archivedSponsorTimes" ADD "cropLeft" INTEGER;
ALTER TABLE "archivedSponsorTimes" ADD "cropRight" INTEGER;
ALTER TABLE "archivedSponsorTimes" ADD "cropTop" INTEGER;
ALTER TABLE "archivedSponsorTimes" ADD "cropBottom" INTEGER;

UPDATE "config" SET value = 45 WHERE key = 'version';

COMMIT;
