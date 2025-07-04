import { config } from "../config";
import { Logger } from "../utils/logger";
import { db, privateDB } from "../databases/databases";
import { getMaxResThumbnail } from "../utils/youtubeApi";
import { getSubmissionUUID } from "../utils/getSubmissionUUID";
import { getHash } from "../utils/getHash";
import { getHashCache } from "../utils/getHashCache";
import { getIP } from "../utils/getIP";
import { getFormattedTime } from "../utils/getFormattedTime";
import { dispatchEvent } from "../utils/webhookUtils";
import { Request, Response } from "express";
import { ActionType, Category, HashedIP, IncomingSegment, IPAddress, SegmentUUID, Service, VideoDuration, VideoID } from "../types/segments.model";
import { deleteLockCategories } from "./deleteLockCategories";
import { QueryCacher } from "../utils/queryCacher";
import { getReputation } from "../utils/reputation";
import { HashedUserID, UserID } from "../types/user.model";
import { isUserVIP } from "../utils/isUserVIP";
import { isUserTempVIP } from "../utils/isUserTempVIP";
import { parseUserAgent } from "../utils/userAgent";
import { getService } from "../utils/getService";
import axios from "axios";
import { vote } from "./voteOnSponsorTime";
import { canSubmit, canSubmitGlobal } from "../utils/permissions";
import { getVideoDetails, videoDetails } from "../utils/getVideoDetails";
import * as youtubeID from "../utils/youtubeID";
import { acquireLock } from "../utils/redisLock";
import { checkBanStatus } from "../utils/checkBan";
import { isRequestInvalid } from "../utils/requestValidator";

type CheckResult = {
    pass: boolean,
    errorMessage: string,
    errorCode: number
};

const CHECK_PASS: CheckResult = {
    pass: true,
    errorMessage: "",
    errorCode: 0
};

async function sendWebhookNotification(userID: string, videoID: string, UUID: string, submissionCount: number, youtubeData: videoDetails, { submissionStart, submissionEnd }: { submissionStart: number; submissionEnd: number; }, segmentInfo: any) {
    const row = await db.prepare("get", `SELECT "userName" FROM "userNames" WHERE "userID" = ?`, [userID]);
    const userName = row !== undefined ? row.userName : null;

    let scopeName = "submissions.other";
    if (submissionCount <= 1) {
        scopeName = "submissions.new";
    }

    dispatchEvent(scopeName, {
        "video": {
            "id": videoID,
            "title": youtubeData?.title,
            "thumbnail": getMaxResThumbnail(videoID),
            "url": `https://www.youtube.com/watch?v=${videoID}`,
        },
        "submission": {
            "UUID": UUID,
            "category": segmentInfo.category,
            "startTime": submissionStart,
            "endTime": submissionEnd,
            "user": {
                "UUID": userID,
                "username": userName,
            },
        },
    });
}

async function sendWebhooks(apiVideoDetails: videoDetails, userID: string, videoID: string, UUID: string, segmentInfo: any, service: Service) {
    if (apiVideoDetails && service == Service.YouTube) {
        const userSubmissionCountRow = await db.prepare("get", `SELECT count(*) as "submissionCount" FROM "sponsorTimes" WHERE "userID" = ?`, [userID]);

        const startTime = parseFloat(segmentInfo.segment[0]);
        const endTime = parseFloat(segmentInfo.segment[1]);
        sendWebhookNotification(userID, videoID, UUID, userSubmissionCountRow.submissionCount, apiVideoDetails, {
            submissionStart: startTime,
            submissionEnd: endTime,
        }, segmentInfo).catch((e) => Logger.error(`sending webhooks: ${e}`));

        // If it is a first time submission
        // Then send a notification to discord
        if (config.discordFirstTimeSubmissionsWebhookURL === null || userSubmissionCountRow.submissionCount > 1) return;

        axios.post(config.discordFirstTimeSubmissionsWebhookURL, {
            embeds: [{
                title: apiVideoDetails.title,
                url: `https://www.youtube.com/watch?v=${videoID}&t=${(parseInt(startTime.toFixed(0)) - 2)}s#requiredSegment=${UUID}`,
                description: `Submission ID: ${UUID}\
                    \n\nTimestamp: \
                    ${getFormattedTime(startTime)} to ${getFormattedTime(endTime)}\
                    \n\nCategory: ${segmentInfo.category}`,
                color: 10813440,
                author: {
                    name: userID,
                },
                thumbnail: {
                    url: getMaxResThumbnail(videoID),
                },
            }],
        })
            .then(res => {
                if (res.status >= 400) {
                    Logger.error("Error sending first time submission Discord hook");
                    Logger.error(JSON.stringify(res));
                    Logger.error("\n");
                }
            })
            .catch(err => {
                Logger.error("Failed to send first time submission Discord hook.");
                Logger.error(JSON.stringify(err));
                Logger.error("\n");
            });
    }
}

// callback:  function(reject: "String containing reason the submission was rejected")
// returns: string when an error, false otherwise

// Looks like this was broken for no defined youtube key - fixed but IMO we shouldn't return
//   false for a pass - it was confusing and lead to this bug - any use of this function in
//   the future could have the same problem.
async function autoModerateSubmission(apiVideoDetails: videoDetails,
    submission: { videoID: VideoID; userID: HashedUserID; segments: IncomingSegment[], service: Service, videoDuration: number }) {
    // get duration from API
    const apiDuration = apiVideoDetails.duration;
    // if API fail or returns 0, get duration from client
    const duration = apiDuration || submission.videoDuration;
    // return false on undefined or 0
    if (!duration) return false;

    if (apiDuration && apiDuration > 2 && duration && duration > 2 && Math.abs(apiDuration - duration) > 3) {
        // YouTube server-side ad injection might be active, reject
        return "YouTube is currently testing a new anti-adblock technique called server-side ad-injection. This causes skips and submissions to be offset by the duration of the ad. It seems that you are affected by this A/B test, so until a fix is developed, we cannot accept submissions from your device due to them potentially being inaccurate.";
    }

    const segments = submission.segments;
    // map all times to float array
    const allSegmentTimes = segments.filter((s) => s.actionType !== ActionType.Chapter)
        .map(segment => [parseFloat(segment.segment[0]), parseFloat(segment.segment[1])]);

    // add previous submissions by this user
    const allSubmittedByUser = await db.prepare("all", `SELECT "startTime", "endTime" FROM "sponsorTimes" WHERE "userID" = ? AND "videoID" = ? AND "votes" > -1 AND "actionType" != 'chapter' AND "hidden" = 0`
        , [submission.userID, submission.videoID]) as { startTime: string, endTime: string }[];

    if (allSubmittedByUser) {
        //add segments the user has previously submitted
        const allSubmittedTimes = allSubmittedByUser.map((segment) => [parseFloat(segment.startTime),  parseFloat(segment.endTime)]);
        allSegmentTimes.push(...allSubmittedTimes);
    }

    //merge all the times into non-overlapping arrays
    const allSegmentsSorted = mergeTimeSegments(allSegmentTimes.sort((a, b) => a[0] - b[0] || a[1] - b[1]));

    //sum all segment times together
    const allSegmentDuration = allSegmentsSorted.reduce((acc, curr) => acc + (curr[1] - curr[0]), 0);

    if (allSegmentDuration > (duration / 100) * 80) {
        // Reject submission if all segments combine are over 80% of the video
        return "Total length of your submitted segments are over 80% of the video.";
    }
    return false;
}

async function checkUserActiveWarning(userID: HashedUserID): Promise<CheckResult> {
    const MILLISECONDS_IN_HOUR = 3600000;
    const now = Date.now();
    const warnings = (await db.prepare("all",
        `SELECT "reason" 
        FROM warnings 
        WHERE "userID" = ? AND "issueTime" > ? AND enabled = 1 AND type = 0
        ORDER BY "issueTime" DESC`,
        [
            userID,
            Math.floor(now - (config.hoursAfterWarningExpires * MILLISECONDS_IN_HOUR))
        ],
    ) as {reason: string}[]).sort((a, b) => (b?.reason?.length ?? 0) - (a?.reason?.length ?? 0));

    if (warnings?.length >= config.maxNumberOfActiveWarnings) {
        const defaultMessage = "Submission rejected due to a tip from a moderator. This means that we noticed you were making some common mistakes"
                                + " that are not malicious, and we just want to clarify the rules. "
                                + "Could you please send a message in discord.gg/SponsorBlock or matrix.to/#/#sponsor:ajay.app so we can further help you? "
                                + `Your userID is ${userID}.`;

        return {
            pass: false,
            errorMessage: defaultMessage + (warnings[0]?.reason?.length > 0 ? `\n\nTip message: '${warnings[0].reason}'` : ""),
            errorCode: 403
        };
    }

    return CHECK_PASS;
}

async function checkInvalidFields(videoID: VideoID, userID: UserID, hashedUserID: HashedUserID
    , segments: IncomingSegment[], videoDurationParam: number, userAgent: string, service: Service): Promise<CheckResult> {
    const invalidFields = [];
    const errors = [];
    if (typeof videoID !== "string" || videoID?.length == 0) {
        invalidFields.push("videoID");
    }
    if (service === Service.YouTube && config.mode !== "test") {
        const sanitizedVideoID = youtubeID.validate(videoID) ? videoID : youtubeID.sanitize(videoID);
        if (!youtubeID.validate(sanitizedVideoID)) {
            invalidFields.push("videoID");
            errors.push("YouTube videoID could not be extracted");
        }
    }
    const minLength = config.minUserIDLength;
    if (typeof userID !== "string" || userID?.length < minLength) {
        invalidFields.push("userID");
        if (userID?.length < minLength) errors.push(`userID must be at least ${minLength} characters long`);
    }
    if (!Array.isArray(segments) || segments.length == 0) {
        invalidFields.push("segments");
    }
    // validate start and end times (no : marks)
    for (const segmentPair of segments) {
        const startTime = segmentPair.segment[0];
        const endTime = segmentPair.segment[1];
        if ((typeof startTime === "string" && startTime.includes(":")) ||
            (typeof endTime === "string" && endTime.includes(":"))) {
            invalidFields.push("segment time");
        }

        if (typeof segmentPair.description !== "string"
                || (segmentPair.description.length !== 0 && segmentPair.actionType !== ActionType.Chapter)) {
            invalidFields.push("segment description");
        }

        if (segmentPair.actionType === ActionType.Chapter && segmentPair.description.length > 200) {
            invalidFields.push("chapter name (too long)");
        }

        const permission = await canSubmit(hashedUserID, segmentPair.category);
        if (!permission.canSubmit) {
            Logger.warn(`Rejecting submission due to lack of permissions for category ${segmentPair.category}: ${segmentPair.segment} ${hashedUserID} ${videoID} ${videoDurationParam} ${userAgent}`);
            invalidFields.push(`permission to submit ${segmentPair.category}`);
            errors.push(permission.reason);
        }
    }

    if (invalidFields.length !== 0) {
        // invalid request
        const formattedFields = invalidFields.join(", ");
        const formattedErrors = errors.join(". ");
        return {
            pass: false,
            errorMessage: `No valid ${formattedFields}. ${formattedErrors}`,
            errorCode: 400
        };
    }

    return CHECK_PASS;
}

async function checkEachSegmentValid(rawIP: IPAddress, paramUserID: UserID, userID: HashedUserID, videoID: VideoID,
    segments: IncomingSegment[], service: Service, isVIP: boolean, isTempVIP: boolean, lockedCategoryList: Array<any>): Promise<CheckResult> {

    for (let i = 0; i < segments.length; i++) {
        if (segments[i] === undefined || segments[i].segment === undefined || segments[i].category === undefined) {
            //invalid request
            return { pass: false, errorMessage: "One of your segments are invalid", errorCode: 400 };
        }

        if (!config.categoryList.includes(segments[i].category)) {
            return { pass: false, errorMessage: "Category doesn't exist.", errorCode: 400 };
        }

        // Reject segment if it's in the locked categories list
        const lockIndex = lockedCategoryList.findIndex(c => segments[i].category === c.category && segments[i].actionType === c.actionType);
        if (!isVIP && lockIndex !== -1) {
            QueryCacher.clearSegmentCache({
                videoID,
                hashedVideoID: await getHashCache(videoID, 1),
                service,
                userID
            });

            Logger.warn(`Caught a submission for a locked category. userID: '${userID}', videoID: '${videoID}', category: '${segments[i].category}', times: ${segments[i].segment}`);
            return {
                pass: false,
                errorCode: 403,
                errorMessage:
                    `Users have voted that all the segments required for this video have already been submitted for the following category: ` +
                    `'${segments[i].category}'\n` +
                    `${lockedCategoryList[lockIndex].reason?.length !== 0 ? `\nReason: '${lockedCategoryList[lockIndex].reason}'\n` : ""}` +
                    `You may need to refresh if you don't see the segments.\n` +
                    `${(segments[i].category === "sponsor" ? "\nMaybe the segment you are submitting is a different category that you have not enabled and is not a sponsor. " +
                    "Categories that aren't sponsor, such as self-promotion can be enabled in the options.\n" : "")}` +
                    `\nIf you believe this is incorrect, please contact someone on chat.sponsor.ajay.app, discord.gg/SponsorBlock or matrix.to/#/#sponsor:ajay.app`
            };
        }

        // For old clients
        if (segments[i].category === "poi_highlight" && segments[i].actionType !== ActionType.Poi) {
            segments[i].actionType = ActionType.Poi;
        }

        if (!config.categorySupport[segments[i].category]?.includes(segments[i].actionType)) {
            return { pass: false, errorMessage: "ActionType is not supported with this category.", errorCode: 400 };
        }

        if (segments[i].actionType === ActionType.Crop) {
            const cropFields = [
                { name: 'cropLeft', value: segments[i].cropLeft },
                { name: 'cropRight', value: segments[i].cropRight },
                { name: 'cropTop', value: segments[i].cropTop },
                { name: 'cropBottom', value: segments[i].cropBottom }
            ];
            for (const field of cropFields) {
                if (field.value !== undefined) {
                    if (!Number.isInteger(field.value) || field.value < 0 || field.value > 255) {
                        return { pass: false, errorMessage: `${field.name} must be an integer between 0 and 255.`, errorCode: 400 };
                    }
                }
            }
            
            const leftValue = segments[i].cropLeft || 0;
            const rightValue = segments[i].cropRight || 0;
            const topValue = segments[i].cropTop || 0;
            const bottomValue = segments[i].cropBottom || 0;
            
            if (leftValue + rightValue > 256) {
                return { pass: false, errorMessage: "cropLeft + cropRight must not exceed 256.", errorCode: 400 };
            }
            if (topValue + bottomValue > 256) {
                return { pass: false, errorMessage: "cropTop + cropBottom must not exceed 256.", errorCode: 400 };
            }
        }

        const startTime = parseFloat(segments[i].segment[0]);
        const endTime = parseFloat(segments[i].segment[1]);

        if (isNaN(startTime) || isNaN(endTime)
                || startTime === Infinity || endTime === Infinity || startTime < 0 || startTime > endTime
                || (segments[i].actionType !== ActionType.Poi
                    && segments[i].actionType !== ActionType.Full && startTime === endTime)
                || (segments[i].actionType === ActionType.Poi && startTime !== endTime)
                || (segments[i].actionType === ActionType.Full && (startTime !== 0 || endTime !== 0))) {
            //invalid request
            return { pass: false, errorMessage: "One of your segments times are invalid (too short, endTime before startTime, etc.)", errorCode: 400 };
        }

        // Check for POI segments before some seconds
        if (!(isVIP || isTempVIP) && segments[i].actionType === ActionType.Poi && startTime < config.poiMinimumStartTime) {
            return { pass: false, errorMessage: `POI cannot be that early`, errorCode: 400 };
        }

        if (!(isVIP || isTempVIP) && segments[i].category === "sponsor"
                && segments[i].actionType === ActionType.Skip && (endTime - startTime) < 1) {
            // Too short
            return { pass: false, errorMessage: "Segments must be longer than 1 second long", errorCode: 400 };
        }

        //check if this info has already been submitted before
        const duplicateCheck2Row = await db.prepare("get", `SELECT "UUID" FROM "sponsorTimes" WHERE "startTime" = ?
            and "endTime" = ? and "category" = ? and "actionType" = ? and "description" = ? and "videoID" = ? and "service" = ?`, [startTime, endTime, segments[i].category, segments[i].actionType, segments[i].description, videoID, service]);
        if (duplicateCheck2Row) {
            segments[i].ignoreSegment = true;

            if (segments[i].actionType === ActionType.Full) {
                // Forward as vote
                await vote(rawIP, duplicateCheck2Row.UUID, paramUserID, 1);
                continue;
            }
        }
    }

    if (segments.every((s) => s.ignoreSegment && s.actionType !== ActionType.Full)) {
        return { pass: false, errorMessage: "Segment has already been submitted before.", errorCode: 409 };
    }

    return CHECK_PASS;
}

async function checkByAutoModerator(videoID: VideoID, userID: HashedUserID, segments: IncomingSegment[], service: Service, apiVideoDetails: videoDetails, videoDuration: number): Promise<CheckResult> {
    // Auto moderator check
    if (service == Service.YouTube && apiVideoDetails) {
        const autoModerateResult = await autoModerateSubmission(apiVideoDetails, { videoID, userID, segments, service, videoDuration });
        if (autoModerateResult) {
            return {
                pass: false,
                errorCode: 403,
                errorMessage: `Submissions rejected: ${autoModerateResult} If this is an issue, send a message on Discord.`
            };
        }
    }
    return CHECK_PASS;
}

async function updateDataIfVideoDurationChange(videoID: VideoID, service: Service, videoDuration: VideoDuration, videoDurationParam: VideoDuration) {
    let lockedCategoryList = await db.prepare("all", 'SELECT category, "actionType", reason from "lockCategories" where "videoID" = ? AND "service" = ?', [videoID, service]);

    const previousSubmissions = await db.prepare("all",
        `SELECT "videoDuration", "UUID" 
        FROM "sponsorTimes" 
        WHERE "videoID" = ? AND "service" = ? AND 
            "hidden" = 0 AND "shadowHidden" = 0 AND 
            "actionType" != 'full' AND
            "votes" > -2 AND "videoDuration" != 0`,
        [videoID, service]
    ) as {videoDuration: VideoDuration, UUID: SegmentUUID}[];

    // If the video's duration is changed, then the video should be unlocked and old submissions should be hidden
    const videoDurationChanged = (videoDuration: number) => videoDuration != 0
        && previousSubmissions.length > 0 && !previousSubmissions.some((e) => Math.abs(videoDuration - e.videoDuration) < 2);

    let apiVideoDetails: videoDetails = null;
    if (service == Service.YouTube) {
        // Don't use cache if we don't know the video duration, or the client claims that it has changed
        const ignoreCache = !videoDurationParam || previousSubmissions.length === 0 || videoDurationChanged(videoDurationParam);
        apiVideoDetails = await getVideoDetails(videoID, ignoreCache);
    }
    const apiVideoDuration = apiVideoDetails?.duration as VideoDuration;
    if (!videoDurationParam || (apiVideoDuration && Math.abs(videoDurationParam - apiVideoDuration) > 2)) {
        // If api duration is far off, take that one instead (it is only precise to seconds, not millis)
        videoDuration = apiVideoDuration || 0 as VideoDuration;
    }

    // Only treat as difference if both the api duration and submitted duration have changed
    if (videoDurationChanged(videoDuration) && (!videoDurationParam || videoDurationChanged(videoDurationParam))) {
        // Hide all previous submissions
        await db.prepare("run", `UPDATE "sponsorTimes" SET "hidden" = 1
            WHERE "videoID" = ? AND "service" = ? AND "videoDuration" != ?
            AND "hidden" = 0 AND "shadowHidden" = 0 AND 
            "actionType" != 'full' AND "votes" > -2`,
        [videoID, service, videoDuration]);

        lockedCategoryList = [];
        deleteLockCategories(videoID, null, null, service).catch((e) => Logger.error(`deleting lock categories: ${e}`));
    }

    return {
        videoDuration,
        apiVideoDetails,
        lockedCategoryList
    };
}

// Disable max submissions for now
// Disable IP ratelimiting for now
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function checkRateLimit(userID:string, videoID: VideoID, service: Service, timeSubmitted: number, hashedIP: string, options: {
    enableCheckByIP: boolean;
    enableCheckByUserID: boolean;
} = {
    enableCheckByIP: false,
    enableCheckByUserID: false
}): Promise<CheckResult> {
    const yesterday = timeSubmitted - 86400000;

    if (options.enableCheckByIP) {
        //check to see if this ip has submitted too many sponsors today
        const rateLimitCheckRow = await privateDB.prepare("get", `SELECT COUNT(*) as count FROM "sponsorTimes" WHERE "hashedIP" = ? AND "videoID" = ? AND "timeSubmitted" > ? AND "service" = ?`, [hashedIP, videoID, yesterday, service]);

        if (rateLimitCheckRow.count >= 10) {
            //too many sponsors for the same video from the same ip address
            return {
                pass: false,
                errorCode: 429,
                errorMessage: "Have submited many sponsors for the same video."
            };
        }
    }

    if (options.enableCheckByUserID) {
        //check to see if the user has already submitted sponsors for this video
        const duplicateCheckRow = await db.prepare("get", `SELECT COUNT(*) as count FROM "sponsorTimes" WHERE "userID" = ? and "videoID" = ?`, [userID, videoID]);

        if (duplicateCheckRow.count >= 16) {
            //too many sponsors for the same video from the same user
            return {
                pass: false,
                errorCode: 429,
                errorMessage: "Have submited many sponsors for the same video."
            };
        }
    }

    return CHECK_PASS;
}

function proxySubmission(req: Request) {
    axios.post(`${config.proxySubmission}/api/skipSegments?userID=${req.query.userID}&videoID=${req.query.videoID}`, req.body)
        .then(res => {
            Logger.debug(`Proxy Submission: ${res.status} (${res.data})`);
        })
        .catch(() => {
            Logger.error("Proxy Submission: Failed to make call");
        });
}

function preprocessInput(req: Request) {
    const videoID = req.query.videoID || req.body.videoID;
    const userID = req.query.userID || req.body.userID;
    const service = getService(req.query.service, req.body.service);
    const videoDurationParam: VideoDuration = (parseFloat(req.query.videoDuration || req.body.videoDuration) || 0) as VideoDuration;
    const videoDuration = videoDurationParam;

    let segments = req.body.segments as IncomingSegment[];
    if (segments === undefined) {
        // Use query instead
        segments = [{
            segment: [req.query.startTime as string, req.query.endTime as string],
            category: req.query.category as Category,
            actionType: (req.query.actionType as ActionType) ?? ActionType.Skip,
            description: req.query.description as string || "",
        }];
    }
    // Add default action type
    segments.forEach((segment) => {
        if (!Object.values(ActionType).some((val) => val === segment.actionType)){
            segment.actionType = ActionType.Skip;
        }

        segment.description ??= "";
        segment.segment = segment.segment.map((time) => typeof segment.segment[0] === "string" ? time?.replace(",", ".") : time);
    });

    const userAgent = req.query.userAgent ?? req.body.userAgent ?? parseUserAgent(req.get("user-agent")) ?? "";

    return { videoID, userID, service, videoDuration, videoDurationParam, segments, userAgent };
}

export async function postSkipSegments(req: Request, res: Response): Promise<Response> {
    if (config.proxySubmission) {
        proxySubmission(req);
    }

    // eslint-disable-next-line prefer-const
    let { videoID, userID: paramUserID, service, videoDuration, videoDurationParam, segments, userAgent } = preprocessInput(req);

    //hash the userID
    if (!paramUserID) {
        return res.status(400).send("No userID provided");
    }
    const userID: HashedUserID = await getHashCache(paramUserID);

    const matchedRule = isRequestInvalid({
        userAgent,
        userAgentHeader: req.headers["user-agent"],
        videoDuration,
        videoID,
        userID: paramUserID,
        service,
        segments,
        endpoint: "sponsorblock-postSkipSegments"
    });
    if (matchedRule !== null) {
        sendNewUserWebhook(config.discordRejectedNewUserWebhookURL, userID, videoID, userAgent, req, videoDurationParam, matchedRule);
        Logger.warn(`Sponsorblock submission rejected by request validator: ${userID} ${videoID} ${videoDurationParam} ${userAgent} ${req.headers["user-agent"]}`);
        return res.status(200).send("OK");
    }

    const invalidCheckResult = await checkInvalidFields(videoID, paramUserID, userID, segments, videoDurationParam, userAgent, service);
    if (!invalidCheckResult.pass) {
        return res.status(invalidCheckResult.errorCode).send(invalidCheckResult.errorMessage);
    }

    const userWarningCheckResult = await checkUserActiveWarning(userID);
    if (!userWarningCheckResult.pass) {
        Logger.warn(`Caught a submission for a warned user. userID: '${userID}', videoID: '${videoID}', category: '${segments.reduce<string>((prev, val) => `${prev} ${val.category}`, "")}', times: ${segments.reduce<string>((prev, val) => `${prev} ${val.segment}`, "")}`);
        return res.status(userWarningCheckResult.errorCode).send(userWarningCheckResult.errorMessage);
    }

    const lock = await acquireLock(`postSkipSegment:${videoID}.${userID}`);
    if (!lock.status) {
        res.status(429).send("Submission already in progress");
        return;
    }

    try {
        const isVIP = (await isUserVIP(userID));
        const isTempVIP = (await isUserTempVIP(userID, videoID));
        const rawIP = getIP(req);

        const newData = await updateDataIfVideoDurationChange(videoID, service, videoDuration, videoDurationParam);
        videoDuration = newData.videoDuration;
        const { lockedCategoryList, apiVideoDetails } = newData;

        // Check if all submissions are correct
        const segmentCheckResult = await checkEachSegmentValid(rawIP, paramUserID, userID, videoID, segments, service, isVIP, isTempVIP, lockedCategoryList);
        if (!segmentCheckResult.pass) {
            lock.unlock();
            return res.status(segmentCheckResult.errorCode).send(segmentCheckResult.errorMessage);
        }

        if (!(isVIP || isTempVIP)) {
            const autoModerateCheckResult = await checkByAutoModerator(videoID, userID, segments, service, apiVideoDetails, videoDurationParam);
            if (!autoModerateCheckResult.pass) {
                return res.status(autoModerateCheckResult.errorCode).send(autoModerateCheckResult.errorMessage);
            }
        }

        const permission = await canSubmitGlobal(userID);
        if (!permission.canSubmit) {
            lock.unlock();

            Logger.warn(`New user trying to submit: ${userID} ${videoID} ${Object.keys(segments?.[0] ?? {})} ${Object.keys(req.query)} ${videoDurationParam} ${userAgent} ${req.headers["user-agent"]}`);
            return res.status(403).send(permission.reason);
        } else if (permission.newUser) {
            sendNewUserWebhook(config.discordNewUserWebhookURL, userID, videoID, userAgent, req, videoDurationParam, undefined);
        }

        // Will be filled when submitting
        const UUIDs = [];
        const newSegments = [];

        //hash the ip 5000 times so no one can get it from the database
        const hashedIP = await getHashCache(rawIP + config.globalSalt) as HashedIP;

        const timeSubmitted = Date.now();

        // const rateLimitCheckResult = checkRateLimit(userID, videoID, service, timeSubmitted, hashedIP);
        // if (!rateLimitCheckResult.pass) {
        //     return res.status(rateLimitCheckResult.errorCode).send(rateLimitCheckResult.errorMessage);
        // }

        //check to see if this user is shadowbanned
        const isBanned = await checkBanStatus(userID, hashedIP);
        const startingVotes = 0;
        const reputation = await getReputation(userID);

        for (const segmentInfo of segments) {
            // Full segments are always rejected since there can only be one, so shadow hide wouldn't work
            if (segmentInfo.ignoreSegment
                || (isBanned && segmentInfo.actionType === ActionType.Full)) {
                continue;
            }

            //this can just be a hash of the data
            //it's better than generating an actual UUID like what was used before
            //also better for duplication checking
            const UUID = getSubmissionUUID(videoID, segmentInfo.category, segmentInfo.actionType,
                segmentInfo.description, userID, parseFloat(segmentInfo.segment[0]), parseFloat(segmentInfo.segment[1]), service);
            const hashedVideoID = getHash(videoID, 1);

            const startingLocked = isVIP ? 1 : 0;
            try {
                await db.prepare("run", `INSERT INTO "sponsorTimes" 
                    ("videoID", "startTime", "endTime", "votes", "locked", "UUID", "userID", "timeSubmitted", "views", "category", "actionType", "service", "videoDuration", "reputation", "shadowHidden", "hashedVideoID", "userAgent", "description", "cropLeft", "cropRight", "cropTop", "cropBottom")
                    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
                    videoID, segmentInfo.segment[0], segmentInfo.segment[1], startingVotes, startingLocked, UUID, userID, timeSubmitted, 0
                    , segmentInfo.category, segmentInfo.actionType, service, videoDuration, reputation, isBanned ? 1 : 0, hashedVideoID, userAgent, segmentInfo.description, segmentInfo.cropLeft, segmentInfo.cropRight, segmentInfo.cropTop, segmentInfo.cropBottom
                ],
                );

                //add to private db as well
                await privateDB.prepare("run", `INSERT INTO "sponsorTimes" VALUES(?, ?, ?, ?)`, [videoID, hashedIP, timeSubmitted, service]);

                await db.prepare("run", `INSERT INTO "videoInfo" ("videoID", "channelID", "title", "published") 
                    SELECT ?, ?, ?, ?
                    WHERE NOT EXISTS (SELECT 1 FROM "videoInfo" WHERE "videoID" = ?)`, [
                    videoID, apiVideoDetails?.authorId || "", apiVideoDetails?.title || "", apiVideoDetails?.published || 0, videoID]);

                // Clear redis cache for this video
                QueryCacher.clearSegmentCache({
                    videoID,
                    hashedVideoID,
                    service,
                    userID
                });
            } catch (err) {
                //a DB change probably occurred
                Logger.error(`Error when putting sponsorTime in the DB: ${videoID}, ${segmentInfo.segment[0]}, ${segmentInfo.segment[1]}, ${userID}, ${segmentInfo.category}. ${err}`);
                lock.unlock();
                return res.sendStatus(500);
            }

            UUIDs.push(UUID);
            newSegments.push({
                UUID: UUID,
                category: segmentInfo.category,
                segment: segmentInfo.segment,
            });
        }

        for (let i = 0; i < segments.length; i++) {
            sendWebhooks(apiVideoDetails, userID, videoID, UUIDs[i], segments[i], service).catch((e) => Logger.error(`call send webhooks ${e}`));
        }

        return res.json(newSegments);
    } catch (err) {
        Logger.error(err as string);
        return res.sendStatus(500);
    } finally {
        lock.unlock();
    }
}

function sendNewUserWebhook(webhookUrl: string, userID: HashedUserID, videoID: any, userAgent: any, req: Request, videoDurationParam: VideoDuration, ruleName: string | undefined) {
    if (!webhookUrl) return;

    axios.post(webhookUrl, {
        "embeds": [{
            "title": userID,
            "url": `https://www.youtube.com/watch?v=${videoID}`,
            "description": `**User Agent**: ${userAgent}\
                        \n**Sent User Agent**: ${req.query.userAgent ?? req.body.userAgent}\
                        \n**Real User Agent**: ${req.headers["user-agent"]}\
                        \n**Video Duration**: ${videoDurationParam}`,
            "color": 10813440,
            "thumbnail": {
                "url": getMaxResThumbnail(videoID),
            },
            "footer": {
                "text": ruleName === undefined ? "Caught by permission check" : `Caught by rule '${ruleName}'`,
            },
        }],
    })
        .then(res => {
            if (res.status >= 400) {
                Logger.error("Error sending reported submission Discord hook");
                Logger.error(JSON.stringify((res.data)));
                Logger.error("\n");
            }
        })
        .catch(err => {
            Logger.error("Failed to send reported submission Discord hook.");
            Logger.error(JSON.stringify(err));
            Logger.error("\n");
        });
}

// Takes an array of arrays:
// ex)
// [
//     [3, 40],
//     [50, 70],
//     [60, 80],
//     [100, 150]
// ]
// => transforms to combining overlapping segments
// [
//     [3, 40],
//     [50, 80],
//     [100, 150]
// ]
function mergeTimeSegments(ranges: number[][]) {
    const result: number[][] = [];
    let last: number[];

    ranges.forEach(function (r) {
        if (!last || r[0] > last[1])
            result.push(last = r);
        else if (r[1] > last[1])
            last[1] = r[1];
    });

    return result;
}
