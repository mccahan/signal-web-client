import { config } from './config.js';
import { log } from './log.js';
import { api } from './signal-api.js';
import { bus } from './bus.js';
import {
  self,
  upsertContact,
  ensureGroupConversation,
  ensureDmConversation,
  listConversations,
} from './store.js';

let lastSync = 0;
let inflight = null;

/** Pull the contact + group roster and fold it into our local view. */
export async function syncRoster({ force = false } = {}) {
  if (!force && Date.now() - lastSync < config.rosterTtlMs) return;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const [contacts, groups] = await Promise.allSettled([
        api.contacts(self.number),
        api.groups(self.number),
      ]);

      if (contacts.status === 'fulfilled' && Array.isArray(contacts.value)) {
        for (const c of contacts.value) {
          // The profile block is where a real human-readable name usually lives.
          const given = c.profile?.given_name || '';
          const family = c.profile?.lastname || '';
          const profileName = [given, family].filter(Boolean).join(' ').trim();
          upsertContact({
            uuid: c.uuid,
            number: c.number,
            name: c.name || c.nickname?.name || '',
            profileName,
            username: c.username,
            hasAvatar: !!c.profile?.has_avatar,
            blocked: !!c.blocked,
          });
        }
        log.debug(`roster: ${contacts.value.length} contact(s)`);
      } else if (contacts.status === 'rejected') {
        log.warn(`contact sync failed: ${contacts.reason?.message}`);
      }

      if (groups.status === 'fulfilled' && Array.isArray(groups.value)) {
        for (const g of groups.value) {
          if (g.blocked) continue;
          ensureGroupConversation({
            internalId: g.internal_id || g.id,
            groupId: g.id,
            name: g.name || '',
            description: g.description || '',
            members: (g.members || []).map((m) =>
              typeof m === 'string' ? m : m.number || m.uuid || ''
            ),
          });
        }
        log.debug(`roster: ${groups.value.length} group(s)`);
      } else if (groups.status === 'rejected') {
        log.warn(`group sync failed: ${groups.reason?.message}`);
      }

      ensureDmConversation(self.contactId);
      lastSync = Date.now();
      bus.publish('conversations', { conversations: listConversations() });
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/**
 * Learn our own ACI so messages we sent are attributed to "You".
 *
 * Without it, `isSelf()` can't recognise our own UUID in incoming envelopes:
 * reactions to our messages would fail to resolve and never reach the browser.
 * Worth a second lookup before giving up.
 */
export async function resolveSelfIdentity(number) {
  try {
    const identities = await api.raw('GET', `/v1/identities/${encodeURIComponent(number)}`, {
      timeoutMs: 15000,
    });
    const mine = (identities || []).find((i) => i.number === number);
    if (mine?.uuid) return mine.uuid;
  } catch (err) {
    log.debug(`identity lookup failed: ${err.message}`);
  }

  // Fall back to the contact roster, which also carries our own entry.
  try {
    const contacts = await api.contacts(number);
    const mine = (contacts || []).find((c) => c.number === number);
    if (mine?.uuid) return mine.uuid;
  } catch (err) {
    log.debug(`contact fallback for own identity failed: ${err.message}`);
  }

  log.warn(
    'could not determine this account\'s own UUID — messages you send from other devices may not be recognised as yours'
  );
  return '';
}

export function startRosterLoop() {
  syncRoster({ force: true }).catch((e) => log.warn(`initial roster sync failed: ${e.message}`));
  // Force it: the interval and the TTL guard are the same length, so a plain
  // syncRoster() here can be rejected as "too soon" by a millisecond and skip
  // the refresh entirely for another full period.
  const timer = setInterval(() => {
    syncRoster({ force: true }).catch((e) => log.debug(`roster sync: ${e.message}`));
  }, config.rosterTtlMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
