require('dotenv').config();
const noblox = require('noblox.js');
const http = require('http');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const BASE_RANK_ID = 1;
const TARGET_RANK_ID = 2;
const CHECK_INTERVAL_MS = 1500;
const RANK_COOLDOWN_MS = 15000;
const AUDIT_CHECK_INTERVAL_MS = 15000;
const LOG_SEND_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
const STATUS_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RETRIES = 4;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// How long to keep an unpaired Unassign/Assign before discarding it
const RANK_PAIR_TIMEOUT_MS = 90 * 1000;

// Fail early with a clear message instead of a confusing noblox/fetch error later
if (!Number.isInteger(GROUP_ID) || GROUP_ID <= 0) {
    console.error('[CONFIG] GROUP_ID is missing or not a number. Set it in your .env / Render environment.');
    process.exit(1);
}
if (!process.env.ROBLOX_COOKIE) {
    console.error('[CONFIG] ROBLOX_COOKIE is missing. Set it in your .env / Render environment.');
    process.exit(1);
}
if (!DISCORD_WEBHOOK_URL) {
    console.warn('[CONFIG] DISCORD_WEBHOOK_URL is not set - logs will only be printed to the console.');
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ==================================================
// STATE
// ==================================================
const processingSet = new Set();
const recentlyRanked = new Map();
let baseRoleSetId = null;
let isPolling = false;

// Audit logger state
let auditLoggerReady = false;
let lastAuditCreated = null;
const processedAuditLogs = new Set();

// Logs waiting for the next 2-minute Discord message
const pendingLogs = [];

// Pending rank-change pairs:
// key = targetUserId (string)
// value = { unassignRole, assignRole, unassignTime, assignTime, targetName }
const pendingRankChanges = new Map();

// Roles cache for accurate Promotion/Demotion detection
let rolesCache = null;
let rolesCacheTime = 0;
const ROLES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ==================================================
// DUMMY SERVER FOR RENDER
// ==================================================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Roblox Auto-Ranker + Logger is running');
}).listen(PORT, () => {
    console.log(`[SYSTEM] Dummy server running on port ${PORT}`);
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
            const isTransient =
                [429, 500, 502, 503, 504].includes(status) ||
                ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EAI_AGAIN', 'ENOTFOUND'].includes(err?.code) ||
                /InternalServerError|Internal Server Error|Too many requests|socket hang up|timed? ?out/i.test(msg);
            if (isTransient && attempt < MAX_RETRIES) {
                const delay = 1200 * attempt;
                console.warn(
                    `[RETRY ${attempt}/${MAX_RETRIES}] ${label} → ${status || err?.code || 'transient error'}. Waiting ${delay}ms...`
                );
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }
}

// ==================================================
// ROLES CACHE
// ==================================================
async function getRolesCached() {
    if (rolesCache && Date.now() - rolesCacheTime < ROLES_CACHE_TTL) {
        return rolesCache;
    }
    try {
        const roles = await withRetry(
            () => noblox.getRoles(GROUP_ID),
            'getRoles'
        );
        rolesCache = roles;
        rolesCacheTime = Date.now();
        console.log(`[ROLES] Cached ${roles.length} roles`);
        return roles;
    } catch (err) {
        console.warn('[ROLES] Failed to refresh roles cache:', err.message || err);
        return rolesCache || [];
    }
}

function getRankNumberByName(roles, roleName) {
    if (!roleName || !roles?.length) return null;
    const found = roles.find(
        r => r.name?.toLowerCase() === String(roleName).toLowerCase()
    );
    return found ? Number(found.rank) : null;
}

// ==================================================
// DISCORD QUEUE
// ==================================================
const discordQueue = [];
let isProcessingDiscord = false;

async function processDiscordQueue() {
    if (isProcessingDiscord || discordQueue.length === 0) {
        return;
    }
    isProcessingDiscord = true;

    try {
    while (discordQueue.length > 0) {
        const { content, embeds, resolve } = discordQueue.shift();
        try {
            const res = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: content || undefined,
                    embeds: embeds?.length ? embeds : undefined,
                    username: 'Group Logger'
                })
            });

            if (res.status === 429) {
                let retryAfter = Number(res.headers.get('Retry-After') || 5);
                if (retryAfter > 60) retryAfter = 60;
                console.warn(`[DISCORD] Rate limited. Waiting ${retryAfter}s...`);
                discordQueue.unshift({ content, embeds, resolve });
                await sleep(retryAfter * 1000);
                continue;
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(`Discord ${res.status}: ${text}`);
            }
            resolve(true);
        } catch (err) {
            console.error('[DISCORD] Failed to send:', err.message || err);
            resolve(false);
        }
        await sleep(1500);
    }
    } finally {
        isProcessingDiscord = false;
    }
}

async function sendDiscord(content, embeds = []) {
    if (!DISCORD_WEBHOOK_URL) {
        console.warn('[DISCORD] No DISCORD_WEBHOOK_URL set');
        return;
    }
    return new Promise((resolve) => {
        discordQueue.push({ content, embeds, resolve });
        processDiscordQueue();
    });
}

// ==================================================
// EMBED
// ==================================================
function makeEmbed(title, description, color = 0x5865F2) {
    return {
        title,
        description,
        color,
        timestamp: new Date().toISOString(),
        footer: { text: 'Group Logger' }
    };
}

// ==================================================
// ADD SIMPLE LOG
// ==================================================
function addPendingLog(message) {
    if (!message) return;
    pendingLogs.push(message);
    console.log(`[LOG QUEUED] ${message}`);
}

// ==================================================
// SEND BATCHED LOGS EVERY 2 MINUTES
// ==================================================
let isSendingLogs = false;
const MAX_PENDING_LOGS = 500;

async function sendBatchedLogs() {
    if (isSendingLogs || pendingLogs.length === 0) {
        return;
    }
    isSendingLogs = true;

    try {
        // Remove duplicate lines while preserving order
        const uniqueLogs = [...new Set(pendingLogs)];
        pendingLogs.length = 0;

        if (!DISCORD_WEBHOOK_URL) {
            return; // already printed to the console when queued
        }

        // Split into several embeds so nothing is dropped (embed description limit is 4096)
        const chunks = [];
        let current = [];
        let length = 0;
        for (const line of uniqueLogs) {
            const safeLine = line.length > 500 ? line.slice(0, 497) + '...' : line;
            if (length + safeLine.length + 1 > 3800 && current.length > 0) {
                chunks.push(current);
                current = [];
                length = 0;
            }
            current.push(safeLine);
            length += safeLine.length + 1;
        }
        if (current.length > 0) chunks.push(current);

        console.log(`[DISCORD] Sending ${uniqueLogs.length} logs in ${chunks.length} message(s)...`);

        for (let i = 0; i < chunks.length; i++) {
            const title = chunks.length > 1 ? `📋 Logs (${i + 1}/${chunks.length})` : '📋 Logs';
            const ok = await sendDiscord(null, [
                makeEmbed(title, chunks[i].join('\n'), 0x5865F2)
            ]);
            if (!ok) {
                // Put the unsent logs back so they go out in the next batch
                const unsent = chunks.slice(i).flat();
                pendingLogs.unshift(...unsent);
                if (pendingLogs.length > MAX_PENDING_LOGS) {
                    pendingLogs.splice(0, pendingLogs.length - MAX_PENDING_LOGS);
                }
                console.warn(`[DISCORD] Send failed, ${unsent.length} log(s) re-queued.`);
                break;
            }
        }
    } finally {
        isSendingLogs = false;
    }
}

// ==================================================
// RANKING LOGIC
// ==================================================
async function getRank1Members() {
    try {
        if (!baseRoleSetId) {
            const roles = await getRolesCached();
            const baseRole = roles.find(r => r.rank === BASE_RANK_ID);
            if (!baseRole) {
                throw new Error(`Role for Rank ${BASE_RANK_ID} not found.`);
            }
            baseRoleSetId = baseRole.id;
            console.log(
                `[SYSTEM] Cached roleset ID for Rank ${BASE_RANK_ID}: ${baseRoleSetId}`
            );
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

async function rankMember(userId, username) {
    if (processingSet.has(userId)) {
        return;
    }

    const lastRanked = recentlyRanked.get(userId);
    if (lastRanked && Date.now() - lastRanked < RANK_COOLDOWN_MS) {
        return;
    }

    processingSet.add(userId);

    try {
        const currentRank = await withRetry(
            () => noblox.getRankInGroup(GROUP_ID, userId),
            `getRankInGroup ${userId}`
        );

        if (currentRank === BASE_RANK_ID) {
            console.log(`\n[NEW MEMBER] ${username} (${userId}) is Rank 1`);
            console.log(`[RANKING] ${username} → Rank ${TARGET_RANK_ID}...`);

            const result = await withRetry(
                () => noblox.setRank(GROUP_ID, userId, TARGET_RANK_ID),
                `setRank ${userId}`
            );

            console.log(
                `[SUCCESS] Ranked ${username} (${userId}) → ${result?.name || result?.newRole?.name || `Rank ${TARGET_RANK_ID}`}`
            );
            recentlyRanked.set(userId, Date.now());
            // Discord message is handled by the audit logger
        } else {
            recentlyRanked.set(userId, Date.now());
        }
    } catch (err) {
        const details =
            err?.errors ||
            err?.response?.data ||
            err?.message ||
            err;
        console.error(`[FAILED] ${username} (${userId}):`, details);
    } finally {
        processingSet.delete(userId);
    }
}

// ==================================================
// AUDIT LOG HELPERS
// ==================================================
function getAuditTargetName(desc) {
    return (
        desc?.TargetName ||
        desc?.TargetUsername ||
        desc?.Target?.name ||
        desc?.Target?.username ||
        'Unknown'
    );
}

const usernameCache = new Map();
async function resolveTargetName(desc) {
    const name = getAuditTargetName(desc);
    if (name !== 'Unknown') return name;
    const id = getAuditTargetId(desc);
    if (!id) return name;
    if (usernameCache.has(String(id))) return usernameCache.get(String(id));
    try {
        const looked = await withRetry(() => noblox.getUsernameFromId(Number(id)), 'getUsernameFromId');
        if (looked) {
            usernameCache.set(String(id), looked);
            return looked;
        }
    } catch (err) {
        console.warn(`[AUDIT] Could not look up username for ${id}: ${err.message || err}`);
    }
    return `User ${id}`;
}

function getAuditTargetId(desc) {
    return (
        desc?.TargetId ||
        desc?.TargetUserId ||
        desc?.Target?.id ||
        desc?.Target?.userId ||
        null
    );
}

function getRoleNameFromDesc(desc) {
    return (
        desc?.RoleSetName ||
        desc?.RoleName ||
        desc?.NewRoleSetName ||
        desc?.OldRoleSetName ||
        desc?.Role?.name ||
        desc?.roleName ||
        desc?.Name ||
        null
    );
}

function getAuditKey(entry) {
    const desc = entry.description || {};
    const created = entry.created
        ? new Date(entry.created).getTime()
        : '';
    const action = entry.actionType || '';
    const target = getAuditTargetId(desc) || '?';
    const roleName = getRoleNameFromDesc(desc) || '';
    const oldRank = desc.OldRoleSetName || desc.OldRank || '';
    const newRank = desc.NewRoleSetName || desc.NewRank || '';

    return [created, action, target, roleName, oldRank, newRank].join('|');
}

function normalizeActionType(actionType) {
    if (!actionType) return '';
    return String(actionType).replace(/\s+/g, '');
}

// ==================================================
// RANK-CHANGE PAIRING
// ==================================================
async function tryCompleteRankChange(targetId) {
    const pending = pendingRankChanges.get(String(targetId));
    if (!pending) return;

    // Need both sides
    if (!pending.unassignRole || !pending.assignRole) {
        return;
    }

    const oldRole = pending.unassignRole;
    const newRole = pending.assignRole;
    const targetName = pending.targetName || 'Unknown';

    // Look up real rank numbers
    const roles = await getRolesCached();
    const oldRankNum = getRankNumberByName(roles, oldRole);
    const newRankNum = getRankNumberByName(roles, newRole);

    let changeType = 'Rank Change';
    if (Number.isFinite(oldRankNum) && Number.isFinite(newRankNum)) {
        if (newRankNum > oldRankNum) {
            changeType = 'Promotion';
        } else if (newRankNum < oldRankNum) {
            changeType = 'Demotion';
        }
    }

    addPendingLog(
        `${targetName} → ${oldRole} to ${newRole} (${changeType})`
    );

    pendingRankChanges.delete(String(targetId));
}

async function handleUnassignRole(entry) {
    const desc = entry.description || {};
    const targetId = getAuditTargetId(desc);
    const targetName = await resolveTargetName(desc);
    const roleName = getRoleNameFromDesc(desc) || 'Unknown';

    if (!targetId) {
        console.warn('[AUDIT] Unassign Role missing TargetId – ignored');
        return;
    }

    const key = String(targetId);
    const existing = pendingRankChanges.get(key) || {};

    existing.unassignRole = roleName;
    existing.unassignTime = Date.now();
    existing.targetName = targetName || existing.targetName;

    pendingRankChanges.set(key, existing);
    console.log(`[AUDIT] Buffered Unassign Role → ${targetName} lost "${roleName}"`);

    await tryCompleteRankChange(targetId);
}

async function handleAssignRole(entry) {
    const desc = entry.description || {};
    const targetId = getAuditTargetId(desc);
    const targetName = await resolveTargetName(desc);
    const roleName = getRoleNameFromDesc(desc) || 'Unknown';

    if (!targetId) {
        console.warn('[AUDIT] Assign Role missing TargetId – ignored');
        return;
    }

    const key = String(targetId);
    const existing = pendingRankChanges.get(key) || {};

    existing.assignRole = roleName;
    existing.assignTime = Date.now();
    existing.targetName = targetName || existing.targetName;

    pendingRankChanges.set(key, existing);
    console.log(`[AUDIT] Buffered Assign Role → ${targetName} gained "${roleName}"`);

    await tryCompleteRankChange(targetId);
}

// Clean up old unpaired entries
function cleanupStaleRankPairs() {
    const now = Date.now();
    for (const [key, pending] of pendingRankChanges) {
        const lastTime = Math.max(
            pending.unassignTime || 0,
            pending.assignTime || 0
        );
        if (now - lastTime > RANK_PAIR_TIMEOUT_MS) {
            console.log(
                `[AUDIT] Discarding unpaired rank change for user ${key}`
            );
            pendingRankChanges.delete(key);
        }
    }
}

// ==================================================
// PROCESS ONE AUDIT ENTRY
// ==================================================
async function processAuditEntry(entry) {
    const rawAction = entry.actionType || '';
    const actionType = normalizeActionType(rawAction);
    const desc = entry.description || {};
    const targetName = await resolveTargetName(desc);

    // ----------------------------------------------
    // CLASSIC ChangeRank (still supported)
    // ----------------------------------------------
    if (actionType === 'ChangeRank') {
        const oldRank =
            desc.OldRoleSetName ||
            desc.OldRank ||
            'Unknown';
        const newRank =
            desc.NewRoleSetName ||
            desc.NewRank ||
            'Unknown';

        const roles = await getRolesCached();
        const oldRankNumber = getRankNumberByName(roles, oldRank);
        const newRankNumber = getRankNumberByName(roles, newRank);

        let changeType = 'Rank Change';
        if (Number.isFinite(oldRankNumber) && Number.isFinite(newRankNumber)) {
            if (newRankNumber > oldRankNumber) changeType = 'Promotion';
            else if (newRankNumber < oldRankNumber) changeType = 'Demotion';
        }

        addPendingLog(
            `${targetName} → ${oldRank} to ${newRank} (${changeType})`
        );
        return;
    }

    // ----------------------------------------------
    // Unassign Role + Assign Role pairing
    // ----------------------------------------------
    if (actionType === 'UnassignRole') {
        await handleUnassignRole(entry);
        return;
    }

    if (actionType === 'AssignRole') {
        await handleAssignRole(entry);
        return;
    }

    // ----------------------------------------------
    // MEMBER REMOVED / EXILED
    // ----------------------------------------------
    if (actionType === 'RemoveMember') {
        addPendingLog(`${targetName} → Exiled / Left`);
        return;
    }

    // ----------------------------------------------
    // JOIN REQUEST ACCEPTED
    // ----------------------------------------------
    if (actionType === 'AcceptJoinRequest') {
        addPendingLog(`${targetName} → Joined`);
        return;
    }

    // ----------------------------------------------
    // JOIN REQUEST DECLINED
    // ----------------------------------------------
    if (actionType === 'DeclineJoinRequest') {
        addPendingLog(`${targetName} → Join Request Declined`);
        return;
    }

    // Everything else is ignored
}

// ==================================================
// AUDIT LOG SCANNER
// ==================================================
let isCheckingAudit = false;
async function checkAuditLog() {
    if (isCheckingAudit) return;
    isCheckingAudit = true;
    try {
        const logs = await withRetry(
            () => noblox.getAuditLog(GROUP_ID, null, null, 'Desc', 50),
            'getAuditLog'
        );

        if (!logs || !Array.isArray(logs.data) || logs.data.length === 0) {
            // An empty log on the first scan still counts as "ready", otherwise the
            // first real entries would be mistaken for old history and skipped.
            if (logs && Array.isArray(logs.data) && !auditLoggerReady) {
                auditLoggerReady = true;
                console.log('[AUDIT] Initial scan complete (no existing logs).');
            }
            return;
        }

        const entries = logs.data
            .slice()
            .sort(
                (a, b) =>
                    new Date(a.created).getTime() -
                    new Date(b.created).getTime()
            );

        // First scan – remember existing logs, send nothing
        if (!auditLoggerReady) {
            const newest = entries[entries.length - 1];
            if (newest) {
                lastAuditCreated = new Date(newest.created).getTime();
                console.log(
                    `[AUDIT] Initial scan complete. Ignoring ${entries.length} old logs.`
                );
                console.log(`[AUDIT] Starting from ${newest.created}`);
            }

            for (const entry of entries) {
                processedAuditLogs.add(getAuditKey(entry));
            }
            auditLoggerReady = true;
            return;
        }

        // New logs
        let newCount = 0;

        for (const entry of entries) {
            const createdTime = new Date(entry.created).getTime();
            if (!Number.isFinite(createdTime)) continue;

            if (
                lastAuditCreated !== null &&
                createdTime < lastAuditCreated
            ) {
                continue;
            }

            const auditKey = getAuditKey(entry);
            if (processedAuditLogs.has(auditKey)) {
                continue;
            }

            processedAuditLogs.add(auditKey);

            if (
                lastAuditCreated === null ||
                createdTime > lastAuditCreated
            ) {
                lastAuditCreated = createdTime;
            }

            newCount++;
            console.log(`[AUDIT] New → ${entry.actionType}`);
            await processAuditEntry(entry);
        }

        if (newCount > 0) {
            console.log(`[AUDIT] Found ${newCount} new audit entries`);
        }

        cleanupStaleRankPairs();

        // Prevent the duplicate Set from growing forever
        if (processedAuditLogs.size > 1500) {
            const values = [...processedAuditLogs];
            processedAuditLogs.clear();
            for (const value of values.slice(-750)) {
                processedAuditLogs.add(value);
            }
        }
    } catch (err) {
        console.error('[AUDIT] Poll error:', err.message || err);
    } finally {
        isCheckingAudit = false;
    }
}

// ==================================================
// START AUDIT LOGGER
// ==================================================
async function startAuditLogger() {
    console.log('[SYSTEM] Audit Log scanner started');
    console.log('[SYSTEM] Discord logs will be sent every 2 minutes');
    console.log('[SYSTEM] Group asset logs are ignored');
    console.log(
        '[SYSTEM] Rank changes detected via Unassign Role + Assign Role pairs'
    );

    // Pre-load roles so the first rank change is accurate
    await getRolesCached();

    await checkAuditLog();
    setInterval(checkAuditLog, AUDIT_CHECK_INTERVAL_MS);
    setInterval(sendBatchedLogs, LOG_SEND_INTERVAL_MS);
}

// ==================================================
// 2-HOUR STATUS UPDATE
// ==================================================
async function sendGroupStatus() {
    try {
        const group = await withRetry(
            () => noblox.getGroup(GROUP_ID),
            'getGroup'
        );

        const memberCount = group.memberCount || 'Unknown';
        const groupName = group.name || 'Group';
        const shout = group.shout?.body
            ? group.shout.body.slice(0, 200)
            : 'No shout';

        const description =
            `**Group:** ${groupName}\n` +
            `**Members:** ${memberCount.toLocaleString()}\n` +
            `**Current Shout:** ${shout}\n\n` +
            `Bot is online and ranking Rank ${BASE_RANK_ID} → Rank ${TARGET_RANK_ID}`;

        await sendDiscord(null, [
            makeEmbed('📊 Group Status Update', description, 0x5865F2)
        ]);

        console.log('[STATUS] 2-hour group update sent');
    } catch (err) {
        console.error(
            '[STATUS] Failed to send update:',
            err.message || err
        );
    }
}

// ==================================================
// MAIN
// ==================================================
async function startAutoRanker() {
    try {
        const currentUser = await noblox.setCookie(
            process.env.ROBLOX_COOKIE
        );

        const botUserId = Number(
            currentUser.UserID || currentUser.id
        );
        const botUsername =
            currentUser.UserName || currentUser.name;

        console.log('==================================================');
        console.log(`Bot Active: ${botUsername} (ID: ${botUserId})`);
        console.log(
            `Auto-ranking: Rank ${BASE_RANK_ID} → Rank ${TARGET_RANK_ID}`
        );
        console.log(`Rank Poll: ${CHECK_INTERVAL_MS}ms`);
        console.log(`Discord Log Batch: 2 minutes`);
        console.log('==================================================\n');

        // Start logger
        await startAuditLogger();

        // 2-hour status
        setTimeout(() => sendGroupStatus(), 30000);
        setInterval(sendGroupStatus, STATUS_INTERVAL_MS);

        console.log(
            '[SYSTEM] Bot is running. Waiting for Rank 1 members...\n'
        );

        // Auto-rank loop
        setInterval(async () => {
            if (isPolling) return;
            isPolling = true;

            try {
                const rank1Members = await getRank1Members();
                if (!rank1Members) return;

                const now = Date.now();
                for (const [id, ts] of recentlyRanked) {
                    if (now - ts > RANK_COOLDOWN_MS * 3) {
                        recentlyRanked.delete(id);
                    }
                }

                for (const player of rank1Members) {
                    const uid = getUserId(player);
                    if (!uid || uid === botUserId) continue;

                    if (!processingSet.has(uid)) {
                        rankMember(
                            uid,
                            player.username || `User ${uid}`
                        );
                    }
                }
            } catch (err) {
                console.warn(
                    `[WARN] Loop error: ${err.message || err}`
                );
            } finally {
                isPolling = false;
            }
        }, CHECK_INTERVAL_MS);
    } catch (error) {
        console.error(
            '[INITIALIZATION ERROR]',
            error?.message || error
        );
        process.exit(1);
    }
}

// ==================================================
// ERROR HANDLERS
// ==================================================
process.on('unhandledRejection', (reason) => {
    console.error(
        '[UNHANDLED REJECTION]',
        reason?.message || reason
    );
});

async function shutdown(signal) {
    console.log(`[SYSTEM] ${signal} received, flushing logs...`);
    try {
        await Promise.race([sendBatchedLogs(), sleep(8000)]);
    } finally {
        process.exit(0);
    }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
    console.error(
        '[UNCAUGHT EXCEPTION]',
        err?.message || err
    );
});

// ==================================================
// START
// ==================================================
startAutoRanker();