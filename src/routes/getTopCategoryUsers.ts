import { db } from "../databases/databases";
import { createMemoryCache } from "../utils/createMemoryCache";
import { config } from "../config";
import { Request, Response } from "express";
import { validateCategories } from "../utils/parseParams";

const MILLISECONDS_IN_MINUTE = 60000;
// eslint-disable-next-line @typescript-eslint/no-misused-promises
const getTopCategoryUsersWithCache = createMemoryCache(generateTopCategoryUsersStats, config.getTopUsersCacheTimeMinutes * MILLISECONDS_IN_MINUTE);
/* istanbul ignore next */
const maxRewardTimePerSegmentInSeconds = config.maxRewardTimePerSegmentInSeconds ?? 86400;

interface DBSegment {
    userName: string,
    viewCount: number,
    totalSubmissions: number,
    minutesSaved: number,
}

async function generateTopCategoryUsersStats(sortBy: string, category: string) {
    const userNames = [];
    const viewCounts = [];
    const totalSubmissions = [];
    const minutesSaved = [];

    const rows: DBSegment[] = await db.prepare("all", `SELECT COUNT(*) as "totalSubmissions", SUM(views) as "viewCount",
        SUM(((CASE WHEN "sponsorTimes"."endTime" - "sponsorTimes"."startTime" > ? THEN ? ELSE "sponsorTimes"."endTime" - "sponsorTimes"."startTime" END) / 60) * "sponsorTimes"."views") as "minutesSaved",
        SUM("votes") as "userVotes", COALESCE("userNames"."userName", "sponsorTimes"."userID") as "userName" FROM "sponsorTimes" LEFT JOIN "userNames" ON "sponsorTimes"."userID"="userNames"."userID"
        LEFT JOIN "shadowBannedUsers" ON "sponsorTimes"."userID"="shadowBannedUsers"."userID"
        WHERE "sponsorTimes"."category" = ? AND "sponsorTimes"."votes" > -1 AND "sponsorTimes"."shadowHidden" != 1 AND "shadowBannedUsers"."userID" IS NULL
        GROUP BY COALESCE("userName", "sponsorTimes"."userID") HAVING SUM("votes") > 2
        ORDER BY "${sortBy}" DESC LIMIT 100`, [maxRewardTimePerSegmentInSeconds, maxRewardTimePerSegmentInSeconds, category]);

    if (rows) {
        for (const row of rows) {
            userNames.push(row.userName);
            viewCounts.push(row.viewCount);
            totalSubmissions.push(row.totalSubmissions);
            minutesSaved.push(category === "chapter" ? 0 : row.minutesSaved);
        }
    }

    return {
        userNames,
        viewCounts,
        totalSubmissions,
        minutesSaved
    };
}

export async function getTopCategoryUsers(req: Request, res: Response): Promise<Response> {
    const sortType = parseInt(req.query.sortType as string);
    const category = req.query.category as string;

    if (sortType == undefined || !validateCategories([category]) ) {
        //invalid request
        return res.sendStatus(400);
    }

    if (db.highLoad()) {
        return res.status(503).send("Disabled for load reasons");
    }

    //setup which sort type to use
    let sortBy = "";
    if (sortType == 0) {
        sortBy = "minutesSaved";
    } else if (sortType == 1) {
        sortBy = "viewCount";
    } else if (sortType == 2) {
        sortBy = "totalSubmissions";
    } else {
        //invalid request
        return res.sendStatus(400);
    }

    const stats = await getTopCategoryUsersWithCache(sortBy, category);

    //send this result
    return res.send(stats);
}
