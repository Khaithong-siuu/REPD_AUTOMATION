require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const noblox = require('noblox.js');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const BASE_RANK_ID = 1;
const TARGET_RANK_ID = 2;
const CHECK_INTERVAL_MS = 1500;
const RANK_COOLDOWN_MS = 15000;
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RETRIES = 4;

// Remembers the last reported member count so a restart doesn't reset the change figure.
// On hosts with a temporary disk (Render free tier) this resets on redeploy, which is fine.
// Set DATA_DIR to a Render persistent-disk mount path (e.g. /data) if you add one.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const STATE_FILE = path.join(DATA_DIR, 'state.json');

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
const processingSet = new Set();
const recentlyRanked = new Map();
const roleNames = {}; // rank number -> role name, used for the promotion log
let baseRoleSetId = null;
let isPolling = false;
let isReporting = false;

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
                const delay = (status === 429 ? 5000 : 1200) * attempt;
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

// Rank change line: "username: Old -> New (promotion)".
// Discord only colors text inside an ansi code block: green for a promotion, red for a demotion.
// Lines are collected and posted together as ONE message every minute.
const LOG_FLUSH_MS = 60 * 1000;
const logQueue = []; // { name, text, color }
let isFlushing = false;

function queueLog(name, text, color) {
    logQueue.push({ name, text, color });
}

function queueRankLog(username, fromName, toName, type) {
    queueLog(username, `${fromName} -> ${toName} (${type})`, type === 'demotion' ? 31 : 32); // 31 = red, 32 = green
}

async function flushLogQueue() {
    if (isFlushing || logQueue.length === 0) return;
    isFlushing = true;

    try {
        const batch = logQueue.splice(0, logQueue.length);

        // Discord allows 2000 characters per message, so a very large batch is split in chunks
        const chunks = [];
        let current = [];
        let length = 0;
        for (const entry of batch) {
            const size = entry.name.length + entry.text.length + 20;
            if (current.length && length + size > 1800) {
                chunks.push(current);
                current = [];
                length = 0;
            }
            current.push(entry);
            length += size;
        }
        if (current.length) chunks.push(current);

        for (let i = 0; i < chunks.length; i++) {
            const body = chunks[i]
                .map((e) => `${e.name}: \u001b[0;${e.color}m${e.text}\u001b[0m`)
                .join('\n');
            const ok = await sendDiscord('```ansi\n' + body + '\n```');
            if (!ok) {
                // Keep the unsent lines and try again on the next flush
                logQueue.unshift(...chunks.slice(i).flat());
                break;
            }
        }
    } finally {
        isFlushing = false;
    }
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
        // Same colored style as the promotion log: green for + (or no change), red for -
        const color = change < 0 ? 31 : 32;
        const sent = await sendDiscord(
            '```ansi\n' + `${group.name}: \u001b[0;${color}m${total}[${sign}${Math.abs(change)}]\u001b[0m` + '\n```'
        );

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
            for (const r of roles) roleNames[r.rank] = r.name;
            console.log(`[SYSTEM] Rank ${BASE_RANK_ID} roleset ID: ${baseRoleSetId}`);
        }

        const members = await withRetry(
            () => noblox.getPlayers(GROUP_ID, baseRoleSetId),
            'getPlayers'
        );
        return Array.isArray(members) ? members : [];
    } catch (err) {
        console.warn(`[WARN] getRank1Members failed: ${err.message || err}`);
        return null;
    }
}

// Members the bot has already ranked are remembered on disk, so a restart (or a staff
// change that still leaves them showing as rank 1) never makes the bot rank them again.
const RANKED_FILE = path.join(DATA_DIR, 'ranked.json');
const RANKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
let rankedBefore = {};
try { rankedBefore = JSON.parse(fs.readFileSync(RANKED_FILE, 'utf8')); } catch { rankedBefore = {}; }

function saveRanked() {
    try { fs.writeFileSync(RANKED_FILE, JSON.stringify(rankedBefore)); } catch {}
}

function markRanked(userId) {
    rankedBefore[userId] = Date.now();
    saveRanked();
}

// On a host with a temporary disk (Render) ranked.json is wiped on every deploy/restart, so the
// bot would think every existing Rank 1 member is new and try to rank all of them.
// To prevent that, the first poll after startup records everyone who is ALREADY Rank 1 and skips
// them. Only people who show up as Rank 1 afterwards get ranked.
// Set BASELINE_ON_START=false to turn this off (e.g. when you use a persistent disk).
const BASELINE_ON_START = String(process.env.BASELINE_ON_START || 'true').toLowerCase() !== 'false';
let baselineDone = !BASELINE_ON_START;

// Returns true if it actually called the Roblox API (so the caller can pace itself)
async function rankMember(userId, username) {
    if (processingSet.has(userId)) return false;

    const prev = rankedBefore[userId];
    if (prev && Date.now() - prev < RANKED_TTL_MS) return false;

    const lastRanked = recentlyRanked.get(userId);
    if (lastRanked && Date.now() - lastRanked < RANK_COOLDOWN_MS) return false;

    processingSet.add(userId);

    try {
        const currentRank = await withRetry(
            () => noblox.getRankInGroup(GROUP_ID, userId),
            `getRankInGroup ${userId}`
        );

        if (currentRank === BASE_RANK_ID) {
            console.log(`[RANKING] ${username} (${userId}): Rank ${BASE_RANK_ID} to Rank ${TARGET_RANK_ID}`);

            const result = await withRetry(
                () => noblox.setRank(GROUP_ID, userId, TARGET_RANK_ID),
                `setRank ${userId}`
            );

            const newName = result?.name || result?.newRole?.name || `Rank ${TARGET_RANK_ID}`;
            console.log(`[RANKING] Done: ${username} (${userId}) is now ${newName}`);
            markRanked(userId);

            const fromName = roleNames[BASE_RANK_ID] || `Rank ${BASE_RANK_ID}`;
            const toName = roleNames[TARGET_RANK_ID] || `Rank ${TARGET_RANK_ID}`;
            queueRankLog(username, fromName, toName, 'promotion');
        }
        recentlyRanked.set(userId, Date.now());
    } catch (err) {
        const details = err?.errors || err?.response?.data || err?.message || err;
        console.error(`[RANKING] Failed for ${username} (${userId}):`, details);
    } finally {
        processingSet.delete(userId);
    }
    return true;
}

// ==================================================
// MANUAL RANK CHANGES (read from the group audit log)
// Staff promotions and demotions done on Roblox are logged
// in the same format. The bot's own rank-ups are skipped here
// because rankMember() already logs those.
// ==================================================
const AUDIT_INTERVAL_MS = 30000;
let auditBotId = null;
let lastAuditTime = Date.now(); // only changes made after startup are logged
const seenAudit = new Set();
const pendingRoles = new Map(); // targetId -> { target, assigned, unassigned, updated }
let isAuditing = false;

async function checkAuditLog() {
    if (isAuditing) return;
    isAuditing = true;

    try {
        const roles = await withRetry(() => noblox.getRoles(GROUP_ID), 'getRoles');
        const roleById = new Map(roles.map((r) => [Number(r.id), r]));

        const log = await withRetry(
            () => noblox.getAuditLog(GROUP_ID, '', undefined, 'Desc', 25),
            'getAuditLog'
        );
        const entries = (Array.isArray(log) ? log : log?.data || []).slice().reverse(); // oldest first

        let newest = lastAuditTime;
        for (const entry of entries) {
            const ts = Date.parse(entry.created);
            if (!Number.isFinite(ts) || ts <= lastAuditTime) continue;
            newest = Math.max(newest, ts);

            const d = entry.description || {};
            const key = `${entry.created}|${d.TargetId}|${d.NewRoleSetId}|${entry.actionType}`;
            if (seenAudit.has(key)) continue;
            seenAudit.add(key);

            const kind = String(entry.actionType).replace(/[^a-z]/gi, '').toLowerCase();

            // The Roles system records a staff promotion as two entries: "Unassign Role" (old role)
            // and "Assign Role" (new role). They are collected per member and paired up after this loop.
            if (kind === 'assignrole' || kind === 'unassignrole') {
                const aId = Number(entry.actor?.user?.userId || entry.actor?.user?.id);
                if (aId && aId === auditBotId) continue;
                if (!d.TargetId || !d.RoleSetName) continue;

                const p = pendingRoles.get(d.TargetId) || {};
                const info = { id: Number(d.RoleSetId), name: d.RoleSetName };
                if (kind === 'assignrole') p.assigned = info;
                else p.unassigned = info;
                p.target = d.TargetName;
                p.updated = Date.now();
                pendingRoles.set(d.TargetId, p);
                continue;
            }

            if (kind !== 'changerank') {
                console.log(`[AUDIT RAW] ${entry.actionType} | actor=${entry.actor?.user?.username} | ${JSON.stringify(d)}`);
                continue;
            }

            const actorId = Number(entry.actor?.user?.userId || entry.actor?.user?.id);
            if (actorId && actorId === auditBotId) continue;

            const oldRole = roleById.get(Number(d.OldRoleSetId));
            const newRole = roleById.get(Number(d.NewRoleSetId));
            const fromName = d.OldRoleSetName || oldRole?.name;
            const toName = d.NewRoleSetName || newRole?.name;
            const target = d.TargetName;
            if (!target || !fromName || !toName) continue;

            const type = oldRole && newRole && newRole.rank < oldRole.rank ? 'demotion' : 'promotion';
            console.log(`[AUDIT] ${target}: ${fromName} -> ${toName} (${type})`);
            queueRankLog(target, fromName, toName, type);
        }
        // Pair up assigned/unassigned roles into one "Old -> New" line
        for (const [tid, p] of pendingRoles) {
            const both = p.assigned && p.unassigned;
            if (!both && Date.now() - p.updated < 90000) continue; // wait up to 90s for the other half
            pendingRoles.delete(tid);

            if (both) {
                if (p.assigned.id === p.unassigned.id) continue; // removed and re-added, no net change
                const oldRole = roleById.get(p.unassigned.id) || roles.find((r) => r.name === p.unassigned.name);
                const newRole = roleById.get(p.assigned.id) || roles.find((r) => r.name === p.assigned.name);
                const type = oldRole && newRole && newRole.rank < oldRole.rank ? 'demotion' : 'promotion';
                console.log(`[AUDIT] ${p.target}: ${p.unassigned.name} -> ${p.assigned.name} (${type})`);
                queueRankLog(p.target, p.unassigned.name, p.assigned.name, type);
            } else {
                // Only one half arrived, so there is no "from" or "to" role to show
                const added = Boolean(p.assigned);
                const role = (p.assigned || p.unassigned).name;
                const color = added ? 32 : 31;
                console.log(`[AUDIT] ${p.target}: ${role} (${added ? 'role added' : 'role removed'})`);
                queueLog(p.target, `${role} (${added ? 'role added' : 'role removed'})`, color);
            }
        }
        lastAuditTime = newest;
    } catch (err) {
        console.warn(`[AUDIT] Check failed: ${err?.message || err}`);
    } finally {
        isAuditing = false;
    }
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
        console.log(`[SYSTEM] Auto-ranking Rank ${BASE_RANK_ID} to Rank ${TARGET_RANK_ID} every ${CHECK_INTERVAL_MS}ms`);

        scheduleReports();

        auditBotId = botUserId;
        setInterval(checkAuditLog, AUDIT_INTERVAL_MS);
        setInterval(flushLogQueue, LOG_FLUSH_MS);

        setInterval(async () => {
            if (isPolling) return;
            isPolling = true;

            try {
                const rank1Members = await getRank1Members();
                if (!rank1Members) return;

                // First poll after startup: remember everyone already at Rank 1 and skip them
                if (!baselineDone) {
                    let count = 0;
                    for (const player of rank1Members) {
                        const uid = getUserId(player);
                        if (!uid || uid === botUserId) continue;
                        if (!rankedBefore[uid]) {
                            rankedBefore[uid] = Date.now();
                            count++;
                        }
                    }
                    saveRanked();
                    baselineDone = true;
                    console.log(`[SYSTEM] Baseline: skipping ${count} member(s) who were already Rank ${BASE_RANK_ID} at startup`);
                    return;
                }

                const now = Date.now();
                for (const [id, ts] of recentlyRanked) {
                    if (now - ts > RANK_COOLDOWN_MS * 3) recentlyRanked.delete(id);
                }

                for (const player of rank1Members) {
                    const uid = getUserId(player);
                    if (!uid || uid === botUserId) continue;
                    // One at a time (not all at once) so Roblox doesn't rate-limit us with 429s
                    const calledApi = await rankMember(uid, player.username || `User ${uid}`);
                    if (calledApi) await sleep(700);
                }
            } catch (err) {
                console.warn(`[WARN] Loop error: ${err.message || err}`);
            } finally {
                isPolling = false;
            }
        }, CHECK_INTERVAL_MS);
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