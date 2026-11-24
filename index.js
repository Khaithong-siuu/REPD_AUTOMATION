require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const noblox = require('noblox.js');
const { Client, GatewayIntentBits, Events, ChannelType, SlashCommandBuilder } = require('discord.js');

const GROUP_ID = parseInt(process.env.GROUP_ID, 10);
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

// Discord bot (for the /promote, /demote, /setrank and /suspend commands)
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
// RoWifi API token (RoWifi dashboard > Tokens). Used to find each staff member's linked Roblox account
// so nobody can change their own rank. If it is empty, that check is switched off.
const ROWIFI_TOKEN = process.env.ROWIFI_TOKEN;

const BASE_RANK_ID = 1;
const TARGET_RANK_ID = 2;
const CHECK_INTERVAL_MS = 1500;
const RANK_COOLDOWN_MS = 15000;
const REPORT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RETRIES = 4;

// Who gets pinged when the bot goes to sleep / shuts down.
// "<@ID>" pings a USER. If this ID is a ROLE, use "<@&ID>" instead (set SLEEP_PING in Render's Environment tab).
const SLEEP_PING = process.env.SLEEP_PING || '<@679398959822929920>';

// Render sets this automatically on web services. Used for the keep-alive ping.
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000; // Render sleeps free services after ~15 min without web traffic

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
let isShuttingDown = false;

// ==================================================
// SERVER FOR RENDER (keeps the web service alive)
// ==================================================
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('REPD ranker is running');
});
server.listen(PORT, () => {
    console.log(`[SYSTEM] Web server listening on port ${PORT}`);
});

// Keep-alive: the bot calls its own public URL so Render sees web traffic and does not put it to sleep.
// This only works while the bot is awake. Add an outside pinger (UptimeRobot / cron-job.org) as a backup.
function startKeepAlive() {
    if (!SELF_URL) {
        console.log('[KEEPALIVE] RENDER_EXTERNAL_URL not set (not running on Render?). Self-ping disabled.');
        return;
    }
    setInterval(() => {
        fetch(SELF_URL)
            .then((r) => r.text())
            .catch((err) => console.warn('[KEEPALIVE] Ping failed:', err.message || err));
    }, KEEPALIVE_INTERVAL_MS);
    console.log(`[KEEPALIVE] Pinging ${SELF_URL} every ${KEEPALIVE_INTERVAL_MS / 60000} minutes`);
}

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
// options.ping     - true lets the message actually ping users/roles (normal logs never ping)
// options.attempts - how many times to try (shutdown uses fewer so it finishes in time)
// ==================================================
async function sendDiscord(content, options = {}) {
    const ping = Boolean(options.ping);
    const attempts = options.attempts || MAX_RETRIES;

    if (!DISCORD_WEBHOOK_URL) {
        console.log(`[REPORT] ${content}`);
        return true;
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const res = await fetch(DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content,
                    allowed_mentions: { parse: ping ? ['users', 'roles'] : [] }
                })
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
            console.error(`[DISCORD] Send failed (attempt ${attempt}/${attempts}):`, err.message || err);
            if (attempt < attempts) await sleep(options.attempts ? 700 : 2000 * attempt);
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
    const red = type === 'demotion' || type === 'suspension'; // 31 = red, 32 = green
    queueLog(username, `${fromName} -> ${toName} (${type})`, red ? 31 : 32);
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
// SLEEP / SHUTDOWN NOTICE
// Render stops a free service by sending SIGTERM (then force-kills it after a short grace period).
// The bot uses that moment to post one last message that pings SLEEP_PING.
// This also fires on redeploys and restarts, because from the bot's side they look the same.
// A crash or a hard kill gives no warning, so no message can be sent in that case.
// ==================================================
async function handleShutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[SYSTEM] Received ${signal}. Sending sleep notice, then exiting.`);

    // Never let the notice delay exit past Render's grace period
    const hardExit = setTimeout(() => process.exit(0), 12000);
    hardExit.unref?.();

    try {
        await flushLogQueue(); // push out any rank lines that were still waiting

        const wake = SELF_URL ? ` Open ${SELF_URL} to wake it.` : '';
        await sendDiscord(
            `${SLEEP_PING} The REPD ranker is going to sleep (or restarting). ` +
            `Auto-ranking and rank logs are paused until it starts again.${wake}`,
            { ping: true, attempts: 3 }
        );
    } catch (err) {
        console.error('[SYSTEM] Sleep notice failed:', err.message || err);
    }

    try { await discordClient?.destroy(); } catch {}
    try { server.close(); } catch {}
    process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// ==================================================
// 2-HOUR MEMBER REPORT
// Format: Redwood Edge Police Department [REPD]: 126[+1]
// ==================================================
async function sendMemberReport() {
    if (isReporting || isShuttingDown) return;
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
    if (isAuditing || isShuttingDown) return;
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

let discordClient = null;

// ==================================================
// DISCORD COMMANDS: /promote  /demote  /setrank  /suspend
//
// WHO CAN DO WHAT is defined in PERMISSION_TIERS below. Nothing else grants access:
// no admin fallback, no environment variable, no extra roles. If a person has both roles,
// the higher tier (Chief Rank) is used. Everything is checked again on the server side of the
// bot, so hiding or showing a command in Discord never decides who is allowed.
// ==================================================
const EPHEMERAL = 64; // only the person who used the command sees the reply

const MIN_MANAGED_RANK = 2; // nobody below this rank can be changed with the commands
const SUSPEND_RANK = 3; // the rank /suspend puts people in
// Where suspension reasons are posted. Set SUSPEND_THREAD_ID in your environment to the ID of the thread
// (the last number in the thread's link). The value below is only used if the variable is missing.
const SUSPEND_TARGET_ID = process.env.SUSPEND_THREAD_ID || '1574647908245045311';
// Thread that records WHO ran each /promote, /demote and /setrank (e.g. "Promotions/demotions by Staff").
// Set STAFF_LOG_THREAD_ID to that thread's ID. If it is empty, this extra log is simply skipped.
const STAFF_LOG_THREAD_ID = process.env.STAFF_LOG_THREAD_ID;
const MIN_REASON_LENGTH = 10; // a suspension reason must be at least this long
const MAX_ACTIONS = 15; // rank changes one Discord user may make...
const RATE_WINDOW_MS = 10 * 60 * 1000; // ...within this window (anti-misuse brake)
const TARGET_COOLDOWN_MS = 10 * 60 * 1000; // the same member can't have their rank changed again for this long

// Highest tier first. skipRanks: never used as a promote/demote step and never set by /setrank.
// setRankOnly: ranks that skip rules hide from /promote and /demote but this tier may set with /setrank.
const PERMISSION_TIERS = [
    {
        key: 'chief',
        label: 'Chief Rank',
        roleId: '1523857118531158136',
        maxRank: 28,
        skipRanks: [3, 4, 5, 6, 7, 13, 18, 23],
        setRankOnly: [5, 6],
        bypassTargetCooldown: true // Chief Rank can fix a mistake straight away
    },
    {
        key: 'hq',
        label: 'Police HQ',
        roleId: '1523856189983559761',
        maxRank: 22,
        skipRanks: [3, 4, 5, 6, 7, 13, 18],
        setRankOnly: [],
        bypassTargetCooldown: false
    }
];

function getTier(interaction) {
    const roles = interaction.member?.roles;
    const has = (id) => (Array.isArray(roles) ? roles.includes(id) : Boolean(roles?.cache?.has(id)));
    return PERMISSION_TIERS.find((t) => has(t.roleId)) || null;
}

// A rank on the normal promote/demote ladder for this tier
function isLadderRank(tier, rank) {
    return rank >= MIN_MANAGED_RANK && rank <= tier.maxRank && !tier.skipRanks.includes(rank);
}

// A rank this tier may set with /setrank (ladder + its special ranks)
function isSettableRank(tier, rank) {
    return isLadderRank(tier, rank) || tier.setRankOnly.includes(rank);
}

// Group roles are cached so commands and autocomplete don't hit Roblox every time
let rolesCache = { at: 0, roles: [] };
async function getGroupRoles(force = false) {
    if (!force && rolesCache.roles.length && Date.now() - rolesCache.at < 5 * 60 * 1000) return rolesCache.roles;
    const roles = await withRetry(() => noblox.getRoles(GROUP_ID), 'getRoles');
    for (const r of roles) roleNames[r.rank] = r.name;
    rolesCache = { at: Date.now(), roles };
    return roles;
}

// Simple per-person limit so one account can't mass-change ranks
const actionTimes = new Map();
function isRateLimited(discordUserId) {
    const now = Date.now();
    const recent = (actionTimes.get(discordUserId) || []).filter((t) => now - t < RATE_WINDOW_MS);
    actionTimes.set(discordUserId, recent);
    return recent.length >= MAX_ACTIONS;
}
function recordAction(discordUserId) {
    const list = actionTimes.get(discordUserId) || [];
    list.push(Date.now());
    actionTimes.set(discordUserId, list);
}

// ---- RoWifi: which Roblox account is this Discord user linked to? ----
const linkCache = new Map(); // discordId -> { id, at }
const LINK_CACHE_MS = 10 * 60 * 1000;

// Returns the linked Roblox user ID, or null if the person is not linked. Throws if RoWifi can't be reached.
async function getLinkedRobloxId(discordId) {
    const cached = linkCache.get(discordId);
    if (cached && Date.now() - cached.at < LINK_CACHE_MS) return cached.id;

    const res = await fetch(`https://api.rowifi.xyz/v3/guilds/${DISCORD_GUILD_ID}/members/${discordId}`, {
        headers: { Authorization: `Bot ${ROWIFI_TOKEN}` },
        signal: AbortSignal.timeout(8000)
    });
    if (res.status === 404) return null; // not linked
    if (!res.ok) throw new Error(`RoWifi answered ${res.status}`);

    const data = await res.json();
    const id = Number(data?.roblox_id) || null;
    if (id) linkCache.set(discordId, { id, at: Date.now() });
    return id;
}

// ---- Misuse alerts: pings Chief Rank in the staff-log thread ----
const CHIEF_ROLE_ID = PERMISSION_TIERS.find((t) => t.key === 'chief').roleId;
const MISUSE_RULES = {
    rate_limit: { threshold: 1, text: `hit the rank-change limit (${MAX_ACTIONS} changes in ${RATE_WINDOW_MS / 60000} minutes)` },
    self_rank: { threshold: 1, text: 'tried to change their own rank' },
    over_limit: { threshold: 5, text: 'keeps trying rank changes their role is not allowed to make' }
};
const misuseHits = new Map(); // "discordId:kind" -> timestamps
const misuseLastAlert = new Map(); // "discordId:kind" -> time of the last alert

async function getStaffLogThread() {
    if (!STAFF_LOG_THREAD_ID || !discordClient) return null;
    const thread = await discordClient.channels.fetch(STAFF_LOG_THREAD_ID);
    if (!thread || !thread.isThread()) {
        console.warn('[STAFF LOG] STAFF_LOG_THREAD_ID is not a thread.');
        return null;
    }
    if (thread.archived) await thread.setArchived(false).catch(() => {});
    return thread;
}

// kind: a key of MISUSE_RULES. The alert is only sent once the threshold is reached,
// and the same person is not alerted for the same thing more than once per window.
async function flagMisuse(interaction, tier, kind, detail = '') {
    try {
        const rule = MISUSE_RULES[kind];
        const key = `${interaction.user.id}:${kind}`;
        const now = Date.now();

        const hits = (misuseHits.get(key) || []).filter((t) => now - t < RATE_WINDOW_MS);
        hits.push(now);
        misuseHits.set(key, hits);
        if (hits.length < rule.threshold) return;
        if (now - (misuseLastAlert.get(key) || 0) < RATE_WINDOW_MS) return;
        misuseLastAlert.set(key, now);

        console.warn(`[MISUSE] ${interaction.user.tag} (${interaction.user.id}) ${rule.text} ${detail}`);

        const thread = await getStaffLogThread();
        if (!thread) return;
        await thread.send({
            content:
                `🚨 <@&${CHIEF_ROLE_ID}> **Possible misuse:** <@${interaction.user.id}> (${tier ? tier.label : 'no staff role'}) ${rule.text}.` +
                `${detail ? `\n${detail}` : ''}\n<t:${Math.floor(now / 1000)}:f>`,
            allowedMentions: { roles: [CHIEF_ROLE_ID], parse: [] }
        });
    } catch (err) {
        console.error('[MISUSE] Could not post alert:', err?.message || err);
    }
}

// Remembers when each member's rank was last changed with a command (resets when the bot restarts)
const targetLastChanged = new Map();

// Posts the suspension record. Returns { channel, url } so follow-up notes can go in the same place.
// Normal case: SUSPEND_THREAD_ID is an existing thread, and the record is posted as a message in it.
// Fallback: if the ID is a forum or text channel instead, a new thread is created in it for each suspension.
async function postSuspensionRecord(title, content) {
    const target = await discordClient.channels.fetch(SUSPEND_TARGET_ID);
    if (!target) throw new Error('Suspension thread/channel not found');

    if (target.isThread()) {
        if (target.archived) await target.setArchived(false).catch(() => {});
        const message = await target.send({ content, allowedMentions: { parse: [] } });
        return { channel: target, url: message.url };
    }

    if (target.type === ChannelType.GuildForum) {
        const thread = await target.threads.create({
            name: title,
            message: { content, allowedMentions: { parse: [] } },
            reason: 'Roblox suspension record'
        });
        return { channel: thread, url: thread.url };
    }
    if (target.type === ChannelType.GuildText) {
        const thread = await target.threads.create({
            name: title,
            autoArchiveDuration: 10080, // 7 days
            type: ChannelType.PublicThread,
            reason: 'Roblox suspension record'
        });
        await thread.send({ content, allowedMentions: { parse: [] } });
        return { channel: thread, url: thread.url };
    }
    throw new Error(`Unsupported suspension target type (${target.type})`);
}

// Writes one line to the staff-log thread: which staff member used which command on whom.
// A problem here never blocks or undoes the rank change.
async function postStaffLog(interaction, tier, command, name, userId, fromName, toName, type) {
    try {
        const thread = await getStaffLogThread();
        if (!thread) return;

        const icon = type === 'promotion' ? '🟢' : '🔴';
        const label = type === 'promotion' ? 'Promotion' : 'Demotion';
        await thread.send({
            content:
                `${icon} **${label}**: **${name}** (Roblox ID ${userId}): ${fromName} → **${toName}**\n` +
                `By <@${interaction.user.id}> (${tier.label}) using /${command} • <t:${Math.floor(Date.now() / 1000)}:f>`,
            allowedMentions: { parse: [] }
        });
    } catch (err) {
        console.error('[STAFF LOG] Could not post:', err?.message || err);
    }
}

async function handleRankCommand(interaction, command) {
    // ---- 1. Who is asking? ----
    const tier = getTier(interaction);
    if (interaction.guildId !== DISCORD_GUILD_ID || !tier) {
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: EPHEMERAL });
        return;
    }
    if (isRateLimited(interaction.user.id)) {
        await flagMisuse(interaction, tier, 'rate_limit', `Last command: /${command}`);
        await interaction.reply({
            content: `Slow down: you can make at most ${MAX_ACTIONS} rank changes every ${RATE_WINDOW_MS / 60000} minutes.`,
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.deferReply();
    const reply = (msg) => interaction.editReply({ content: msg, allowedMentions: { parse: [] } });

    const typedName = interaction.options.getString('username', true).trim();
    const wantedRank = command === 'setrank' ? interaction.options.getInteger('rank', true) : null;
    const reason = command === 'suspend' ? interaction.options.getString('reason', true).trim() : null;

    if (reason !== null && reason.length < MIN_REASON_LENGTH) {
        return reply(`Please give a proper reason (at least ${MIN_REASON_LENGTH} characters). Nobody was suspended.`);
    }
    if (wantedRank !== null && !isSettableRank(tier, wantedRank)) {
        await flagMisuse(interaction, tier, 'over_limit', `Tried /setrank to rank ${wantedRank}`);
        return reply(`Your **${tier.label}** role is not allowed to set rank ${wantedRank}.`);
    }

    try {
        // ---- 2. Find the Roblox user ----
        let userId = null;
        try {
            userId = Number(await withRetry(() => noblox.getIdFromUsername(typedName), `getIdFromUsername ${typedName}`));
        } catch {
            userId = null;
        }
        if (!userId) return reply(`Could not find a Roblox user named **${typedName}**.`);

        // Nobody may change their own rank. Needs RoWifi to know which Roblox account is theirs.
        if (ROWIFI_TOKEN) {
            let ownRobloxId;
            try {
                ownRobloxId = await getLinkedRobloxId(interaction.user.id);
            } catch (err) {
                console.error('[ROWIFI] Lookup failed:', err?.message || err);
                return reply('I could not check your linked Roblox account with RoWifi right now, so **nothing was changed**. Try again in a minute.');
            }
            if (!ownRobloxId) {
                return reply('Your Discord account is not linked to Roblox with RoWifi, so I can not allow rank changes. Verify with RoWifi first. Nothing was changed.');
            }
            if (ownRobloxId === userId) {
                await flagMisuse(interaction, tier, 'self_rank', `Command: /${command} on their own account (${typedName})`);
                return reply("You can't change your own rank.");
            }
        }

        // Same member can't be ranked again too soon (suspensions are never blocked by this)
        if (command !== 'suspend' && !tier.bypassTargetCooldown) {
            const last = targetLastChanged.get(userId);
            if (last && Date.now() - last < TARGET_COOLDOWN_MS) {
                const until = Math.ceil((last + TARGET_COOLDOWN_MS) / 1000);
                return reply(
                    `**${typedName}**'s rank was already changed recently, so it is locked for now. ` +
                    `You can change it again <t:${until}:R>. A Chief Rank can override this.`
                );
            }
        }

        // Don't collide with the auto-ranker or another command working on the same user
        if (processingSet.has(userId)) return reply('That user is being processed right now. Try again in a few seconds.');
        processingSet.add(userId);

        try {
            // ---- 3. Look up ranks ----
            const roles = await getGroupRoles();
            const [botRank, currentRank, name] = await Promise.all([
                withRetry(() => noblox.getRankInGroup(GROUP_ID, auditBotId), 'getRankInGroup bot'),
                withRetry(() => noblox.getRankInGroup(GROUP_ID, userId), `getRankInGroup ${userId}`),
                withRetry(() => noblox.getUsernameFromId(userId), `getUsernameFromId ${userId}`).catch(() => typedName)
            ]);
            const roleOf = (rank) => roles.find((r) => r.rank === rank);
            const nameOf = (rank) => roleOf(rank)?.name || `Rank ${rank}`;

            // ---- 4. Safety checks on the target ----
            if (userId === auditBotId) return reply("I can't change my own rank.");
            if (currentRank === 0) return reply(`**${name}** is not in the group.`);
            if (currentRank >= botRank) return reply(`I can't change **${name}**: their rank is equal to or higher than mine.`);

            if (currentRank === SUSPEND_RANK) {
                return reply(
                    command === 'suspend'
                        ? `**${name}** is already suspended.`
                        : `**${name}** is suspended (rank ${SUSPEND_RANK}). Ranks of suspended members can't be changed with this command.`
                );
            }

            // Promote/demote only work from a rank on the ladder. /setrank and /suspend may also touch special ranks.
            const canTouchCurrent = command === 'promote' || command === 'demote'
                ? isLadderRank(tier, currentRank)
                : isSettableRank(tier, currentRank);
            if (!canTouchCurrent) {
                await flagMisuse(interaction, tier, 'over_limit', `Tried /${command} on ${name} (rank ${currentRank})`);
                return reply(
                    `**${name}** is ${nameOf(currentRank)} (rank ${currentRank}). Your **${tier.label}** role is not allowed to change members at that rank.`
                );
            }

            // ---- 5. Work out the new rank ----
            const ladder = roles.map((r) => r.rank).filter((r) => isLadderRank(tier, r)).sort((a, b) => a - b);
            let toRank;

            if (command === 'promote') {
                toRank = ladder.find((r) => r > currentRank);
                if (toRank === undefined) return reply(`**${name}** is already at the highest rank you can promote to (${nameOf(currentRank)}).`);
            } else if (command === 'demote') {
                toRank = [...ladder].reverse().find((r) => r < currentRank);
                if (toRank === undefined) return reply(`**${name}** is already at the lowest rank you can demote to (${nameOf(currentRank)}).`);
            } else if (command === 'setrank') {
                toRank = wantedRank;
                if (!roleOf(toRank)) return reply(`There is no rank ${toRank} in the group.`);
                if (toRank === currentRank) return reply(`**${name}** is already ${nameOf(toRank)}.`);
                if (toRank === SUSPEND_RANK) return reply('Use /suspend to suspend someone.');
            } else {
                toRank = SUSPEND_RANK;
                if (!roleOf(toRank)) return reply(`The suspension rank (${SUSPEND_RANK}) does not exist in the group.`);
            }

            if (toRank >= botRank) return reply(`I can't set **${name}** to ${nameOf(toRank)}: that rank is equal to or higher than mine.`);

            const type = command === 'suspend' ? 'suspension' : toRank > currentRank ? 'promotion' : 'demotion';
            let record = null;

            // ---- 6. Suspensions need a written record BEFORE anything changes ----
            if (command === 'suspend') {
                const date = new Date().toISOString().slice(0, 10);
                const title = `Suspension | ${name} | ${date}`.slice(0, 100);
                const recordText =
                    `**Suspension record**\n` +
                    `**User:** ${name} (Roblox ID ${userId})\n` +
                    `**Rank before:** ${nameOf(currentRank)} (rank ${currentRank})\n` +
                    `**Suspended by:** <@${interaction.user.id}> (${tier.label})\n` +
                    `**Time:** <t:${Math.floor(Date.now() / 1000)}:F>\n` +
                    `**Reason:** ${reason}`;
                try {
                    record = await postSuspensionRecord(title, recordText);
                } catch (err) {
                    console.error('[COMMAND] Could not post suspension record:', err?.message || err);
                    return reply(
                        'I could not post in the suspension thread, so **nobody was suspended**. ' +
                        'Check that SUSPEND_THREAD_ID is correct and that I can view that thread and send messages in it.'
                    );
                }
            }

            // ---- 7. Change the rank ----
            try {
                await withRetry(() => noblox.setRank(GROUP_ID, userId, toRank), `setRank ${userId}`);
            } catch (err) {
                console.error(`[COMMAND] setRank failed for ${name} (${userId}):`, err?.message || err);
                if (record) await record.channel.send('⚠️ The rank change FAILED. The user was NOT suspended.').catch(() => {});
                return reply('Roblox refused the rank change, so nothing was changed. Check the console for details.');
            }

            recordAction(interaction.user.id);
            if (command !== 'suspend') targetLastChanged.set(userId, Date.now());
            recentlyRanked.set(userId, Date.now());
            if (currentRank === BASE_RANK_ID || toRank === BASE_RANK_ID) markRanked(userId);

            // ---- 8. Log it (same format as the other rank logs; who ran the command goes to the console) ----
            queueRankLog(name, nameOf(currentRank), nameOf(toRank), type);
            console.log(
                `[COMMAND] ${interaction.user.tag} (${interaction.user.id}, ${tier.label}) ${type}: ` +
                `${name} (${userId}) ${nameOf(currentRank)} -> ${nameOf(toRank)}`
            );
            if (record) await record.channel.send(`✅ **${name}** was moved to **${nameOf(toRank)}**.`).catch(() => {});
            if (command !== 'suspend') {
                // Suspensions already name the staff member in the suspension thread
                await postStaffLog(interaction, tier, command, name, userId, nameOf(currentRank), nameOf(toRank), type);
            }

            const arrow = `${nameOf(currentRank)} → **${nameOf(toRank)}**`;
            if (command === 'suspend') return reply(`🚫 Suspended **${name}**: ${arrow}\nRecord: ${record.url}`);
            return reply(`${type === 'promotion' ? '✅ Promoted' : '⬇️ Demoted'} **${name}**: ${arrow}`);
        } finally {
            processingSet.delete(userId);
        }
    } catch (err) {
        console.error(`[COMMAND] ${command} failed:`, err?.errors || err?.message || err);
        await reply('Something went wrong. Nothing was changed unless a confirmation above says so. Check the console for details.').catch(() => {});
    }
}

// /rankinfo: read-only look at a member and what the person asking could do with them
async function handleRankInfo(interaction) {
    const tier = getTier(interaction);
    if (interaction.guildId !== DISCORD_GUILD_ID || !tier) {
        await interaction.reply({ content: 'You do not have permission to use this command.', flags: EPHEMERAL });
        return;
    }

    await interaction.deferReply({ flags: EPHEMERAL });
    const reply = (msg) => interaction.editReply({ content: msg, allowedMentions: { parse: [] } });
    const typedName = interaction.options.getString('username', true).trim();

    try {
        let userId = null;
        try {
            userId = Number(await withRetry(() => noblox.getIdFromUsername(typedName), `getIdFromUsername ${typedName}`));
        } catch {
            userId = null;
        }
        if (!userId) return reply(`Could not find a Roblox user named **${typedName}**.`);

        const roles = await getGroupRoles();
        const [currentRank, name] = await Promise.all([
            withRetry(() => noblox.getRankInGroup(GROUP_ID, userId), `getRankInGroup ${userId}`),
            withRetry(() => noblox.getUsernameFromId(userId), `getUsernameFromId ${userId}`).catch(() => typedName)
        ]);
        const nameOf = (rank) => roles.find((r) => r.rank === rank)?.name || `Rank ${rank}`;

        if (currentRank === 0) return reply(`**${name}** (Roblox ID ${userId}) is not in the group.`);

        const lines = [`**${name}** (Roblox ID ${userId})`, `Rank: **${nameOf(currentRank)}** (rank ${currentRank})`];

        if (currentRank === SUSPEND_RANK) {
            lines.push('Status: suspended. Their rank can not be changed with the commands.');
        } else if (!isSettableRank(tier, currentRank)) {
            lines.push(`Your **${tier.label}** role is not allowed to change members at this rank.`);
        } else {
            const ladder = roles.map((r) => r.rank).filter((r) => isLadderRank(tier, r)).sort((a, b) => a - b);
            if (isLadderRank(tier, currentRank)) {
                const up = ladder.find((r) => r > currentRank);
                const down = [...ladder].reverse().find((r) => r < currentRank);
                lines.push(`You can promote them to: ${up === undefined ? 'nothing (highest you can reach)' : `**${nameOf(up)}** (rank ${up})`}`);
                lines.push(`You can demote them to: ${down === undefined ? 'nothing (lowest you can reach)' : `**${nameOf(down)}** (rank ${down})`}`);
            } else {
                lines.push('They are at a special rank, so only /setrank can change them.');
            }

            const last = targetLastChanged.get(userId);
            if (!tier.bypassTargetCooldown && last && Date.now() - last < TARGET_COOLDOWN_MS) {
                lines.push(`Locked: their rank was changed recently. Open again <t:${Math.ceil((last + TARGET_COOLDOWN_MS) / 1000)}:R>.`);
            }
        }
        return reply(lines.join('\n'));
    } catch (err) {
        console.error('[COMMAND] rankinfo failed:', err?.errors || err?.message || err);
        await reply('Something went wrong while looking that up. Check the console for details.').catch(() => {});
    }
}

// /staffsummary: counts who did how many promotions, demotions and suspensions, read back from the log threads.
// Discord itself is the storage, so the numbers survive restarts. Chief Rank only.
async function readThreadMessages(thread, sinceMs) {
    const found = [];
    let before;
    for (let page = 0; page < 30; page++) {
        const batch = await thread.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (batch.size === 0) break;
        let reachedOld = false;
        for (const msg of batch.values()) {
            if (msg.createdTimestamp < sinceMs) {
                reachedOld = true;
                continue;
            }
            found.push(msg);
        }
        before = batch.last().id;
        if (reachedOld) break;
    }
    return found;
}

async function handleStaffSummary(interaction) {
    const tier = getTier(interaction);
    if (interaction.guildId !== DISCORD_GUILD_ID || !tier || tier.key !== 'chief') {
        await interaction.reply({ content: 'Only Chief Rank can use this command.', flags: EPHEMERAL });
        return;
    }
    if (!STAFF_LOG_THREAD_ID) {
        await interaction.reply({ content: 'STAFF_LOG_THREAD_ID is not set, so there is nothing to summarise.', flags: EPHEMERAL });
        return;
    }

    await interaction.deferReply();
    const days = interaction.options.getInteger('days') || 7;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;
    const stats = new Map(); // discordId -> { promotions, demotions, suspensions }
    const bump = (id, field) => {
        const row = stats.get(id) || { promotions: 0, demotions: 0, suspensions: 0 };
        row[field] += 1;
        stats.set(id, row);
    };

    try {
        // Promotions and demotions come from the staff-log thread
        const staffThread = await getStaffLogThread();
        if (!staffThread) return interaction.editReply('I can not open the staff-log thread. Check STAFF_LOG_THREAD_ID.');
        for (const msg of await readThreadMessages(staffThread, since)) {
            if (msg.author.id !== discordClient.user.id) continue;
            const by = msg.content.match(/By <@(\d+)>/);
            if (!by) continue;
            if (msg.content.startsWith('🟢 **Promotion**')) bump(by[1], 'promotions');
            else if (msg.content.startsWith('🔴 **Demotion**')) bump(by[1], 'demotions');
        }

        // Suspensions come from the suspension thread (only possible when it is an existing thread)
        let suspensionNote = '';
        const suspendThread = await discordClient.channels.fetch(SUSPEND_TARGET_ID).catch(() => null);
        if (suspendThread && suspendThread.isThread()) {
            for (const msg of await readThreadMessages(suspendThread, since)) {
                if (msg.author.id !== discordClient.user.id) continue;
                const by = msg.content.match(/\*\*Suspended by:\*\* <@(\d+)>/);
                if (by) bump(by[1], 'suspensions');
            }
        } else {
            suspensionNote = '\n(Suspensions are not included: SUSPEND_THREAD_ID is not a thread.)';
        }

        if (stats.size === 0) return interaction.editReply({ content: `No logged staff actions in the last ${days} day(s).${suspensionNote}`, allowedMentions: { parse: [] } });

        const rows = [...stats.entries()]
            .map(([id, r]) => ({ id, ...r, total: r.promotions + r.demotions + r.suspensions }))
            .sort((a, b) => b.total - a.total);
        const sum = (field) => rows.reduce((n, r) => n + r[field], 0);
        const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

        const lines = rows.slice(0, 25).map(
            (r) => `<@${r.id}>: ${plural(r.promotions, 'promotion')}, ${plural(r.demotions, 'demotion')}, ${plural(r.suspensions, 'suspension')} (${r.total} total)`
        );
        const content =
            `**Staff summary: last ${days} day(s)**\n${lines.join('\n')}\n\n` +
            `**Totals:** ${plural(sum('promotions'), 'promotion')}, ${plural(sum('demotions'), 'demotion')}, ${plural(sum('suspensions'), 'suspension')}` +
            (rows.length > 25 ? `\n(Showing the top 25 of ${rows.length} staff.)` : '') +
            suspensionNote;
        return interaction.editReply({ content, allowedMentions: { parse: [] } });
    } catch (err) {
        console.error('[COMMAND] staffsummary failed:', err?.message || err);
        return interaction.editReply('Could not read the log threads. Check that I can read message history in them.').catch(() => {});
    }
}

// Suggests the ranks the person is allowed to set while they type in /setrank
async function handleRankAutocomplete(interaction) {
    const tier = getTier(interaction);
    if (!tier || interaction.guildId !== DISCORD_GUILD_ID) return interaction.respond([]);

    const typed = String(interaction.options.getFocused() || '').toLowerCase();
    const choices = rolesCache.roles
        .filter((r) => isSettableRank(tier, r.rank))
        .filter((r) => `${r.rank} ${r.name}`.toLowerCase().includes(typed))
        .sort((a, b) => a.rank - b.rank)
        .slice(0, 25)
        .map((r) => ({ name: `${r.rank} - ${r.name}`.slice(0, 100), value: r.rank }));
    return interaction.respond(choices);
}

async function startDiscordBot() {
    if (!DISCORD_BOT_TOKEN || !DISCORD_CLIENT_ID || !DISCORD_GUILD_ID) {
        console.warn('[DISCORD] DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID or DISCORD_GUILD_ID is missing. The rank commands are disabled.');
        return;
    }

    if (!ROWIFI_TOKEN) {
        console.warn('[ROWIFI] ROWIFI_TOKEN is not set. The "can\'t change your own rank" check is OFF.');
    }
    if (!STAFF_LOG_THREAD_ID) {
        console.warn('[STAFF LOG] STAFF_LOG_THREAD_ID is not set. Staff log lines and misuse alerts will not be posted.');
    }

    const usernameOption = (o) => o.setName('username').setDescription('Roblox username').setRequired(true);
    const commands = [
        new SlashCommandBuilder()
            .setName('promote')
            .setDescription('Promote a Roblox user to the next rank')
            .addStringOption(usernameOption),
        new SlashCommandBuilder()
            .setName('demote')
            .setDescription('Demote a Roblox user to the previous rank')
            .addStringOption(usernameOption),
        new SlashCommandBuilder()
            .setName('setrank')
            .setDescription('Set a Roblox user to a specific rank')
            .addStringOption(usernameOption)
            .addIntegerOption((o) =>
                o.setName('rank').setDescription('Rank to set').setRequired(true).setAutocomplete(true)
            ),
        new SlashCommandBuilder()
            .setName('staffsummary')
            .setDescription('Chief Rank only: promotions, demotions and suspensions per staff member')
            .addIntegerOption((o) =>
                o.setName('days').setDescription('How many days back (default 7)').setMinValue(1).setMaxValue(30)
            ),
        new SlashCommandBuilder()
            .setName('rankinfo')
            .setDescription('Look up a Roblox user\'s rank and what you can do with it (changes nothing)')
            .addStringOption(usernameOption),
        new SlashCommandBuilder()
            .setName('suspend')
            .setDescription('Suspend a Roblox user (the reason is recorded in the suspension thread)')
            .addStringOption(usernameOption)
            .addStringOption((o) =>
                o.setName('reason').setDescription('Why they are being suspended').setRequired(true).setMaxLength(900)
            )
    ].map((c) => c.toJSON());

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    discordClient = client;

    client.once(Events.ClientReady, async (c) => {
        try {
            const guild = await c.guilds.fetch(DISCORD_GUILD_ID);
            await guild.commands.set(commands);
            console.log(`[DISCORD] Logged in as ${c.user.tag}. Commands registered: /promote /demote /setrank /suspend /rankinfo /staffsummary`);
        } catch (err) {
            console.error('[DISCORD] Could not register commands:', err?.message || err);
        }
        await getGroupRoles().catch((err) => console.warn('[DISCORD] Could not preload group roles:', err?.message || err));
    });

    client.on(Events.InteractionCreate, async (interaction) => {
        try {
            if (interaction.isAutocomplete()) {
                if (interaction.commandName === 'setrank') await handleRankAutocomplete(interaction);
                return;
            }
            if (!interaction.isChatInputCommand()) return;
            if (interaction.commandName === 'rankinfo') {
                await handleRankInfo(interaction);
            } else if (interaction.commandName === 'staffsummary') {
                await handleStaffSummary(interaction);
            } else if (['promote', 'demote', 'setrank', 'suspend'].includes(interaction.commandName)) {
                await handleRankCommand(interaction, interaction.commandName);
            }
        } catch (err) {
            console.error('[DISCORD] Interaction error:', err?.message || err);
        }
    });

    client.on('error', (err) => console.error('[DISCORD] Client error:', err?.message || err));

    try {
        await client.login(DISCORD_BOT_TOKEN);
    } catch (err) {
        console.error('[DISCORD] Login failed:', err?.message || err);
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

        // Every start means the bot was asleep, restarted or just deployed. Say so (no ping).
        await sendDiscord('The REPD ranker is online. Changes made while it was asleep are not logged.');

        startKeepAlive();
        scheduleReports();

        auditBotId = botUserId;
        startDiscordBot(); // runs alongside the ranker; a Discord problem never stops the ranking
        setInterval(checkAuditLog, AUDIT_INTERVAL_MS);
        setInterval(flushLogQueue, LOG_FLUSH_MS);

        setInterval(async () => {
            if (isPolling || isShuttingDown) return;
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
                    if (isShuttingDown) break;
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