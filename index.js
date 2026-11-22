require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const noblox = require('noblox.js');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const BASE_RANK_ID = 1;
const TARGET_RANK_ID = 2;
// Roblox rate-limits group actions hard, so ranking is done one member at a time.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 20000;     // how often to look for rank 1 members
const RANK_DELAY_MS = Number(process.env.RANK_DELAY_MS) || 4000;            // pause between two setRank calls
const RATE_LIMIT_PAUSE_MS = Number(process.env.RATE_LIMIT_PAUSE_MS) || 60000; // first pause after a 429, doubles each time
const MAX_RATE_LIMIT_PAUSE_MS = 10 * 60 * 1000;
const FAIL_COOLDOWN_MS = 15 * 60 * 1000;                                    // don't retry a member that failed for this long
const RANK_COOLDOWN_MS = 60 * 1000;
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RETRIES = 4;

// Remembers the last reported member count so a restart doesn't reset the change figure.
// On hosts with a temporary disk (Render free tier) this resets on redeploy, which is fine.
const STATE_FILE = path.join(__dirname, 'state.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ==================================================
// CONFIG CHECK
// ==================================================
if (!Number.isInteger(GROUP_ID) || GROUP_ID <= 0) {
    console.error('[CONFIG] GROUP_ID is missing or not a number.');
    process.exit(1);
}
if (!process.env.ROBLOX_COOKIE) {
    console.error('[CONFIG] ROBLOX_COOKIE is missing.');
    process.exit(1);
}
if (!DISCORD_WEBHOOK_URL) {
    console.warn('[CONFIG] DISCORD_WEBHOOK_URL is not set. Reports will only be printed to the console.');
}

// ==================================================
// STATE
// ==================================================
const recentlyRanked = new Map();
let baseRoleSetId = null;
let isPolling = false;
let isReporting = false;

// Ranking queue
const rankQueue = [];
const queuedIds = new Set();
const failedUntil = new Map();
let workerRunning = false;
let pausedUntil = 0;
let currentPauseMs = 0;

// ==================================================
// SERVER FOR RENDER (keeps the web service alive)
// ==================================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('REPD ranker is running');
}).listen(PORT, () => {
    console.log(`[SYSTEM] Web server listening on port ${PORT}`);
});

// ==================================================
// HELPERS
// ==================================================
function getUserId(player) {
    if (!player) return null;
    const id = player.userId || player.id;
    return id ? Number(id) : null;
}

async function withRetry(fn, label = 'API call') {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const msg = err?.message || String(err);
            const status = err?.httpStatusCode || err?.statusCode || err?.response?.status;
            const transient =
                [429, 500, 502, 503, 504].includes(status) ||
                ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(err?.code) ||
                /InternalServerError|Internal Server Error|Too many requests|socket hang up|timed? ?out/i.test(msg);
            if (transient && attempt < MAX_RETRIES) {
                const delay = 1200 * attempt;
                console.warn(`[RETRY ${attempt}/${MAX_RETRIES}] ${label}: ${status || err?.code || 'transient error'}. Waiting ${delay}ms`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function saveState(state) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    } catch (err) {
        console.warn('[STATE] Could not save state:', err.message || err);
    }
}

// ==================================================
// DISCORD (plain text only)
// ==================================================
async function sendDiscord(content) {
    if (!DISCORD_WEBHOOK_URL) {
        console.log(`[REPORT] ${content}`);
        return true;
    }

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const res = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });

            if (res.status === 429) {
                const retryAfter = Math.min(Number(res.headers.get('Retry-After') || 5), 60);
                console.warn(`[DISCORD] Rate limited. Waiting ${retryAfter}s`);
                await sleep(retryAfter * 1000);
                continue;
            }
            if (!res.ok) {
                throw new Error(`Discord ${res.status}: ${await res.text()}`);
            }
            return true;
        } catch (err) {
            console.error(`[DISCORD] Send failed (attempt ${attempt}/${MAX_RETRIES}):`, err.message || err);
            await sleep(2000 * attempt);
        }
    }
    return false;
}

// ==================================================
// 2-HOUR MEMBER REPORT
// Format: Redwood Edge Police Department [REPD]: 126[+1]
// ==================================================
async function sendMemberReport() {
    if (isReporting) return;
    isReporting = true;

    try {
        const group = await withRetry(() => noblox.getGroup(GROUP_ID), 'getGroup');
        const total = Number(group.memberCount);
        if (!Number.isFinite(total)) {
            throw new Error('Group member count was not returned');
        }

        const previous = loadState();
        const change = previous && Number.isFinite(previous.count) ? total - previous.count : 0;
        const sign = change < 0 ? '-' : '+';

        const line = `${group.name}: ${total}[${sign}${Math.abs(change)}]`;
        const sent = await sendDiscord(line);

        if (sent) {
            // Only move the baseline once the report actually went out
            saveState({ count: total, at: Date.now() });
            console.log(`[REPORT] ${line}`);
        }
    } catch (err) {
        console.error('[REPORT] Failed:', err.message || err);
    } finally {
        isReporting = false;
    }
}

function scheduleReports() {
    const state = loadState();
    const age = state?.at ? Date.now() - state.at : Infinity;

    // First report shortly after start, unless one went out recently (restart / redeploy)
    const firstDelay = age >= REPORT_INTERVAL_MS ? 30 * 1000 : REPORT_INTERVAL_MS - age;
    console.log(`[SYSTEM] Next member report in ${Math.round(firstDelay / 60000)} minute(s)`);

    setTimeout(() => {
        sendMemberReport();
        setInterval(sendMemberReport, REPORT_INTERVAL_MS);
    }, firstDelay);
}

// ==================================================
// RANKING LOGIC
// ==================================================
async function getRank1Members() {
    try {
        if (!baseRoleSetId) {
            const roles = await withRetry(() => noblox.getRoles(GROUP_ID), 'getRoles');
            const baseRole = roles.find((r) => r.rank === BASE_RANK_ID);
            if (!baseRole) {
                throw new Error(`Role for Rank ${BASE_RANK_ID} not found.`);
            }
            baseRoleSetId = baseRole.id;
            console.log(`[SYSTEM] Rank ${BASE_RANK_ID} roleset ID: ${baseRoleSetId}`);
        }

        const members = await withRetry(
            () => noblox.getPlayers(GROUP_ID, baseRoleSetId),
            'getPlayers'
        );
        return Array.isArray(members) ? members : [];
    } catch (err) {
        if (isRateLimited(err)) {
            pauseForRateLimit();
        } else {
            console.warn(`[WARN] getRank1Members failed: ${err.message || err}`);
        }
        return null;
    }
}

function isRateLimited(err) {
    const status = err?.httpStatusCode || err?.statusCode || err?.response?.status;
    return status === 429 || /too many requests/i.test(err?.message || '');
}

function pauseForRateLimit() {
    currentPauseMs = Math.min(
        currentPauseMs ? currentPauseMs * 2 : RATE_LIMIT_PAUSE_MS,
        MAX_RATE_LIMIT_PAUSE_MS
    );
    pausedUntil = Date.now() + currentPauseMs;
    console.warn(`[RATE LIMIT] Roblox said slow down. Pausing for ${Math.round(currentPauseMs / 1000)}s`);
}

// Returns 'ok', 'failed' or 'rate_limited'
async function rankMember(userId, username) {
    try {
        console.log(`[RANKING] ${username} (${userId}): Rank ${BASE_RANK_ID} to Rank ${TARGET_RANK_ID}`);
        const result = await noblox.setRank(GROUP_ID, userId, TARGET_RANK_ID);
        const newName = result?.name || result?.newRole?.name || `Rank ${TARGET_RANK_ID}`;
        console.log(`[RANKING] Done: ${username} (${userId}) is now ${newName}`);
        recentlyRanked.set(userId, Date.now());
        currentPauseMs = 0; // a success means the limit has cleared
        return 'ok';
    } catch (err) {
        if (isRateLimited(err)) {
            return 'rate_limited';
        }
        const details = err?.errors || err?.response?.data || err?.message || err;
        console.error(`[RANKING] Failed for ${username} (${userId}):`, details);
        failedUntil.set(userId, Date.now() + FAIL_COOLDOWN_MS);
        return 'failed';
    }
}

async function runRankWorker() {
    if (workerRunning) return;
    workerRunning = true;

    try {
        while (rankQueue.length > 0) {
            const wait = pausedUntil - Date.now();
            if (wait > 0) {
                await sleep(Math.min(wait, 5000));
                continue;
            }

            const item = rankQueue.shift();
            const outcome = await rankMember(item.uid, item.username);

            if (outcome === 'rate_limited') {
                rankQueue.unshift(item); // try this one again after the pause
                pauseForRateLimit();
                continue;
            }

            queuedIds.delete(item.uid);
            await sleep(RANK_DELAY_MS);
        }
    } finally {
        workerRunning = false;
    }
}

function enqueueMember(uid, username) {
    if (queuedIds.has(uid)) return;
    if ((failedUntil.get(uid) || 0) > Date.now()) return;
    const last = recentlyRanked.get(uid);
    if (last && Date.now() - last < RANK_COOLDOWN_MS) return;

    queuedIds.add(uid);
    rankQueue.push({ uid, username });
}

// ==================================================
// MAIN
// ==================================================
async function start() {
    try {
        const currentUser = await noblox.setCookie(process.env.ROBLOX_COOKIE);
        const botUserId = Number(currentUser.UserID || currentUser.id);
        const botUsername = currentUser.UserName || currentUser.name;

        console.log(`[SYSTEM] Logged in as ${botUsername} (${botUserId})`);
        console.log(`[SYSTEM] Auto-ranking Rank ${BASE_RANK_ID} to Rank ${TARGET_RANK_ID}, one member every ${RANK_DELAY_MS / 1000}s`);

        scheduleReports();

        setInterval(async () => {
            if (isPolling) return;
            // Don't look for more work while paused or while the queue is still being worked through
            if (Date.now() < pausedUntil || rankQueue.length > 0) return;
            isPolling = true;

            try {
                const rank1Members = await getRank1Members();
                if (!rank1Members) return;

                const now = Date.now();
                for (const [id, ts] of recentlyRanked) {
                    if (now - ts > RANK_COOLDOWN_MS * 3) recentlyRanked.delete(id);
                }
                for (const [id, until] of failedUntil) {
                    if (until < now) failedUntil.delete(id);
                }

                for (const player of rank1Members) {
                    const uid = getUserId(player);
                    if (!uid || uid === botUserId) continue;
                    enqueueMember(uid, player.username || `User ${uid}`);
                }

                if (rankQueue.length > 0) {
                    console.log(`[SYSTEM] ${rankQueue.length} member(s) waiting to be ranked`);
                    runRankWorker();
                }
            } catch (err) {
                console.warn(`[WARN] Loop error: ${err.message || err}`);
            } finally {
                isPolling = false;
            }
        }, POLL_INTERVAL_MS);
    } catch (error) {
        console.error('[INIT] Failed to start:', error?.message || error);
        process.exit(1);
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED REJECTION]', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION]', err?.message || err);
});

start();