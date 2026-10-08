// =====================================================================
// VXL BD Client Desk — Supabase data layer
// =====================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = window.ERP_CONFIG?.SUPABASE_URL;

const SUPABASE_ANON = window.ERP_CONFIG?.SUPABASE_ANON_KEY;

const sb = createClient(SUPABASE_URL, SUPABASE_ANON);


// =====================================================================
// UI ↔ DATABASE SHAPE
// =====================================================================

const toUI = (row) => ({
  id: row.id,
  name: row.name,
  country: row.location,
  countries: (row.company_countries ?? []).map((x) => x.country),
  channel: row.channel,
  category: row.category,

  handler: row.handler?.name ?? 'Unassigned',
  handlerId: row.handler_id,

  status: row.status,
  priority: row.priority,

  lastContacted: row.last_contacted,
  notes: row.notes,

  leadSince: row.lead_since,
  convertedAt: row.converted_at,

  created: row.created_at?.slice(0, 10),
  createdBy: row.creator?.name ?? 'Import',

  items: (row.items ?? []).map((i) => ({
    id: i.id,
    kind: i.kind,
    text: i.text,
    deadline: i.deadline,
    lead: i.lead_days,
    recur: i.recur,

    done: i.done,
    doneAt: i.done_at,
    doneBy: i.closer?.name,

    spawned: i.spawned,
    createdBy: i.author?.name,
    createdAt: i.created_at?.slice(0, 10),
  })),
});


const COMPANY_SELECT = `
  *,
  handler:profiles!companies_handler_id_fkey(id,name,email),
  creator:profiles!companies_created_by_fkey(name),
  items(
    *,
    closer:profiles!items_done_by_fkey(name),
    author:profiles!items_created_by_fkey(name)
  ),
     company_countries(country)
`;


// =====================================================================
// ERROR HANDLING
// =====================================================================

// Resolve a handler NAME (what the dropdowns emit) to a profile uuid.
// 'Unassigned' / '' / null all become null. This is the fix for the
// "invalid input syntax for type uuid" error when reassigning.
let _profileCache = [];
async function handlerNameToId(name) {
  if (!name || name === 'Unassigned') return null;
  let hit = _profileCache.find((p) => p.name === name);
  if (!hit) {
    const { data } = await sb.from('profiles').select('id,name');
    _profileCache = data ?? [];
    hit = _profileCache.find((p) => p.name === name);
  }
  return hit ? hit.id : null;
}

function dbError(error, fallback = 'Database operation failed.') {
  if (!error) return null;

  if (error.code === '23505') {
    return new Error('That company already exists in this channel.');
  }

  if (error.code === '23503') {
    return new Error('This record refers to data that no longer exists.');
  }

  if (error.code === '42501' || error.code === 'PGRST301') {
    return new Error('You do not have permission to perform this action.');
  }

  return new Error(error.message || fallback);
}


async function requireSuccess(result, fallback) {
  const { data, error } = result;

  if (error) {
    throw dbError(error, fallback);
  }

  return data;
}


// =====================================================================
// API
// =====================================================================

export const API = {

  // -------------------------------------------------------------------
  // AUTH
  // -------------------------------------------------------------------

  async signIn(email, password) {
    const { data, error } =
      await sb.auth.signInWithPassword({
        email,
        password
      });

    if (error) {
      throw dbError(error, 'Unable to sign in.');
    }

    if (!data.user) {
      throw new Error('Unable to sign in.');
    }

    const { data: me, error: profileError } =
      await sb
        .from('profiles')
        .select('*')
        .eq('id', data.user.id)
        .single();

    if (profileError) {
      await sb.auth.signOut();
      throw dbError(
        profileError,
        'Could not load your account.'
      );
    }

    if (!me?.active) {
      await sb.auth.signOut();
      throw new Error(
        'This account has been deactivated.'
      );
    }

    const { error: eventError } =
      await sb
        .from('sign_in_events')
        .insert({
          user_id: me.id,
          name: me.name,
          email: me.email,
          kind: 'in'
        });

    if (eventError) {
      console.warn(
        'Could not record sign-in event:',
        eventError.message
      );
    }

    return me;
  },


  async signOut(me) {
    if (me) {
      const { error } =
        await sb
          .from('sign_in_events')
          .insert({
            user_id: me.id,
            name: me.name,
            email: me.email,
            kind: 'out'
          });

      if (error) {
        console.warn(
          'Could not record sign-out event:',
          error.message
        );
      }
    }

    const { error } = await sb.auth.signOut();

    if (error) {
      throw dbError(error, 'Unable to sign out.');
    }
  },


  async requestPasswordSet(email) {
    const { error } =
      await sb.auth.resetPasswordForEmail(
        email,
        {
          redirectTo: window.location.href
        }
      );

    if (error) {
      throw dbError(
        error,
        'Unable to send password reset email.'
      );
    }
  },


  async changePassword(newPass) {
    const { error } =
      await sb.auth.updateUser({
        password: newPass
      });

    if (error) {
      throw dbError(
        error,
        'Unable to change password.'
      );
    }
  },


  async currentUser() {
    const {
      data: { session },
      error: sessionError
    } = await sb.auth.getSession();

    if (sessionError) {
      throw dbError(
        sessionError,
        'Could not restore your session.'
      );
    }

    if (!session) {
      return null;
    }

    const { data: me, error } =
      await sb
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .single();

    if (error) {
      throw dbError(
        error,
        'Could not load your account.'
      );
    }

    return me?.active ? me : null;
  },


  // -------------------------------------------------------------------
  // READS
  // -------------------------------------------------------------------

  async loadAll() {

    const {
      data: { session }
    } = await sb.auth.getSession();
    const myId = session?.user?.id ?? null;

    const [
      companies,
      users,
      reqs,
      log,
      sessions,
      snaps,
      notifs,
      pending
    ] = await Promise.all([

      sb
        .from('companies')
        .select(COMPANY_SELECT)
        .order('name'),

      sb
        .from('profiles')
        .select('*')
        .order('name'),

      sb
        .from('assignment_requests')
        .select(`
          *,
          requester:profiles!assignment_requests_requester_id_fkey(
            name,
            email
          ),
          company:companies(name)
        `)
        .order('created_at', {
          ascending: false
        }),

      sb
        .from('activity_log')
        .select('*')
        .order('at', {
          ascending: false
        })
        .limit(400),

      sb
        .from('sign_in_events')
        .select('*')
        .order('at', {
          ascending: false
        })
        .limit(500),

      sb
        .from('daily_snapshots')
        .select('*')
        .order('snap_date')
    ,

      sb
        .from('notifications')
        .select('*')
        .eq('user_id', myId)
        .order('at', { ascending: false })
        .limit(60),

      sb
        .from('v_pending_logs')
        .select('*')
        .order('days_since', { ascending: false })
    ]);


    if (companies.error) {
      throw dbError(
        companies.error,
        'Could not load companies.'
      );
    }

    if (users.error) {
      throw dbError(
        users.error,
        'Could not load team members.'
      );
    }

    if (reqs.error) {
      throw dbError(
        reqs.error,
        'Could not load assignment requests.'
      );
    }

    if (log.error) {
      throw dbError(
        log.error,
        'Could not load activity.'
      );
    }

    if (sessions.error) {
      throw dbError(
        sessions.error,
        'Could not load sign-in history.'
      );
    }

    if (snaps.error) {
      throw dbError(
        snaps.error,
        'Could not load dashboard history.'
      );
    }


    return {

      clients:
        (companies.data ?? []).map(toUI),

      users:
        users.data ?? [],

      reqs:
        (reqs.data ?? []).map((r) => ({
          id: r.id,
          clientId: r.company_id,
          client: r.company?.name,
          from: r.requester?.name,
          email: r.requester?.email,
          note: r.note,
          at: r.created_at,
          status: r.status
        })),

      log:
        (log.data ?? []).map((l) => ({
          t: l.at,
          who: l.actor,
          text: l.text
        })),

      sessions:
        (sessions.data ?? []).map((s) => ({
          t: s.at,
          who: s.name,
          email: s.email,
          type: s.kind
        })),

      snaps:
        (snaps.data ?? []).map((s) => ({
          date: s.snap_date,
          ...s.metrics
        })),

      notifs:
        (notifs.data ?? []).map((n) => ({
          id: n.id, kind: n.kind, text: n.text,
          companyId: n.company_id, read: n.read, at: n.at
        })),

      pending:
        (pending.data ?? []).map((r) => ({
          id: r.id, name: r.name, channel: r.channel, category: r.category,
          handler: r.handler ?? 'Unassigned', handlerId: r.handler_id,
          lastContacted: r.last_contacted, daysSince: r.days_since
        }))
    };
  },


  // -------------------------------------------------------------------
  // COMPANIES
  // -------------------------------------------------------------------

  async updateCompany(id, patch) {

    // Multi-country lives in its own table — handle then drop from patch.
    if ('countries' in patch) {
      await API.setCountries(id, patch.countries);
      patch = { ...patch };
      delete patch.countries;
    }

    const map = {
      name: 'name',
      country: 'location',
      channel: 'channel',
      category: 'category',
      handler: 'handler_id',
      status: 'status',
      priority: 'priority',
      lastContacted: 'last_contacted',
      notes: 'notes',
      leadSince: 'lead_since',
      convertedAt: 'converted_at'
    };

    const body = {};

    for (const [key, value] of Object.entries(patch)) {
      // A handler arrives as a NAME from the dropdown; convert to uuid.
      body[map[key] ?? key] =
        key === 'handler' ? await handlerNameToId(value) : value;
    }

    if (Object.keys(body).length === 0) return;

    const { error } =
      await sb
        .from('companies')
        .update(body)
        .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'Could not update company.'
      );
    }
  },

  // Replace the set of countries for a company (chips in the UI).
  async setCountries(companyId, list) {
    await sb.from('company_countries').delete().eq('company_id', companyId);
    const clean = [...new Set((list ?? []).map((x) => x.trim()).filter(Boolean))];
    if (clean.length) {
      const { error } = await sb.from('company_countries')
        .insert(clean.map((country) => ({ company_id: companyId, country })));
      if (error) throw dbError(error, 'Could not save countries.');
    }
  },


  async saveClients(clients) {

    for (const c of clients) {

      await API.updateCompany(c.id, {
        name: c.name,
        country: c.country,
        channel: c.channel,
        category: c.category,
        handler: c.handlerId,
        status: c.status,
        priority: c.priority,
        lastContacted: c.lastContacted,
        notes: c.notes,
        leadSince: c.leadSince,
        convertedAt: c.convertedAt
      });

    }
  },


  async bulkUpdate(ids, patch) {

    // Bulk country set writes to the child table for every id.
    if ('countries' in patch) {
      for (const id of ids) await API.setCountries(id, patch.countries);
      patch = { ...patch }; delete patch.countries;
    }

    const map = { handler: 'handler_id', country: 'location' };
    const body = {};

    for (const [key, value] of Object.entries(patch)) {
      body[map[key] ?? key] =
        key === 'handler' ? await handlerNameToId(value) : value;
    }

    if (Object.keys(body).length) {
      const { error } =
        await sb.from('companies').update(body).in('id', ids);
      if (error) throw dbError(error, 'Could not update companies.');
    }
  },


  async addCompany(c, bullets) {

    const insertBody = {
      name: c.name,
      location: (c.countries ?? []).join(', ') || c.country || '',
      channel: c.channel,
      category: c.category,
      handler_id: c.handlerId,
      priority: c.priority,
      lead_since:
        c.category === 'Lead'
          ? new Date().toISOString().slice(0, 10)
          : null
    };


    const {
      data,
      error
    } = await sb
      .from('companies')
      .insert(insertBody)
      .select('id')
      .single();


    if (error) {
      throw dbError(
        error,
        'Could not add company.'
      );
    }

    if (!data?.id) {
      throw new Error(
        'Company was created but no company ID was returned.'
      );
    }


    if (c.countries?.length) {
      await API.setCountries(data.id, c.countries);
    }

    if (bullets?.length) {
      await API.addItems(
        data.id,
        bullets
      );
    }


    return data.id;
  },


  async deleteCompany(id) {

    const { error } =
      await sb
        .from('companies')
        .delete()
        .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'Only the BD lead can delete a company.'
      );
    }
  },


  async reloadCompany(id) {

    const {
      data,
      error
    } = await sb
      .from('companies')
      .select(COMPANY_SELECT)
      .eq('id', id)
      .single();

    if (error) {
      throw dbError(
        error,
        'Could not reload company.'
      );
    }

    return data
      ? toUI(data)
      : null;
  },


  // -------------------------------------------------------------------
  // ITEMS / FOLLOW-UPS
  // -------------------------------------------------------------------

  async addItems(companyId, bullets) {

    if (!bullets?.length) {
      return;
    }

    const rows =
      bullets.map((b) => ({
        company_id: companyId,
        kind: b.kind,
        text: b.text,
        deadline: b.deadline || null,
        lead_days: b.lead ?? 7,
        recur: b.recur ?? 'None'
      }));


    const { error } =
      await sb
        .from('items')
        .insert(rows);

    if (error) {
      throw dbError(
        error,
        'Could not add follow-up.'
      );
    }
  },


  async updateItem(id, patch) {

    const map = {
      lead: 'lead_days',
      deadline: 'deadline',
      recur: 'recur',
      text: 'text',
      kind: 'kind'
    };

    const body = {};

    for (const [key, value] of Object.entries(patch)) {
      body[map[key] ?? key] =
        value === ''
          ? null
          : value;
    }


    const { error } =
      await sb
        .from('items')
        .update(body)
        .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'Could not update follow-up.'
      );
    }
  },


  async toggleItem(id, done, userId) {

    const { error } =
      await sb
        .from('items')
        .update({
          done,
          done_at:
            done
              ? new Date().toISOString()
              : null,
          done_by:
            done
              ? userId
              : null
        })
        .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'You can only close items on companies you handle.'
      );
    }
  },


  async deleteItem(id) {

    const { error } =
      await sb
        .from('items')
        .delete()
        .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'Could not remove follow-up.'
      );
    }
  },


  // -------------------------------------------------------------------
  // ASSIGNMENT REQUESTS
  // -------------------------------------------------------------------

  async raiseRequest(
    companyId,
    note,
    userId
  ) {

    const {
      error
    } = await sb
      .from('assignment_requests')
      .insert({
        company_id: companyId,
        requester_id: userId,
        note
      });

    if (error) {
      throw dbError(
        error,
        'Could not create assignment request.'
      );
    }
  },


  async resolveRequest(
    id,
    approve,
    companyId,
    requesterId,
    adminId
  ) {

    if (approve) {

      const {
        error
      } = await sb
        .from('companies')
        .update({
          handler_id: requesterId
        })
        .eq('id', companyId);

      if (error) {
        throw dbError(
          error,
          'Could not assign company.'
        );
      }
    }


    const {
      error
    } = await sb
      .from('assignment_requests')
      .update({
        status:
          approve
            ? 'approved'
            : 'declined',
        resolved_by: adminId,
        resolved_at:
          new Date().toISOString()
      })
      .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'Could not resolve assignment request.'
      );
    }
  },


  // -------------------------------------------------------------------
  // TEAM
  // -------------------------------------------------------------------

  async createUser(name, email, role = 'member') {

    const {
      data: { session },
      error: sessionError
    } = await sb.auth.getSession();

    if (sessionError || !session) {
      throw new Error('You must be signed in.');
    }

    const {
      data,
      error
    } = await sb.functions.invoke(
      'create-user',
      {
        body: {
          name,
          email,
          role
        }
      }
    );

    if (error) {
      throw new Error(
        error.message || 'Could not create user.'
      );
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    if (!data?.user) {
      throw new Error(
        'User creation completed but no user was returned.'
      );
    }

    return data.user;
  },


  async setRole(id, role) {

    const {
      error
    } = await sb
      .from('profiles')
      .update({ role })
      .eq('id', id);

    if (error) {
      throw dbError(
        error,
        'Could not update member role.'
      );
    }
  },


  async setActive(id, active) {

    const { error } =
      await sb
        .from('profiles')
        .update({ active })
        .eq('id', id);

    if (error) {
      throw dbError(
        error,
        active
          ? 'Could not reactivate member.'
          : 'Could not deactivate member.'
      );
    }
  },


  async handover(
    fromId,
    toId,
    keepDates
  ) {

    const {
      data: companies,
      error: companyError
    } = await sb
      .from('companies')
      .select('id')
      .eq('handler_id', fromId);

    if (companyError) {
      throw dbError(
        companyError,
        'Could not find companies for handover.'
      );
    }


    const companyIds =
      (companies ?? []).map(c => c.id);


    const {
      error: assignmentError
    } = await sb
      .from('companies')
      .update({
        handler_id: toId || null
      })
      .eq('handler_id', fromId);

    if (assignmentError) {
      throw dbError(
        assignmentError,
        'Could not hand over companies.'
      );
    }


    if (
      !keepDates &&
      companyIds.length
    ) {

      const {
        error: itemError
      } = await sb
        .from('items')
        .update({
          deadline: null
        })
        .in(
          'company_id',
          companyIds
        )
        .eq('done', false);

      if (itemError) {
        throw dbError(
          itemError,
          'Could not clear follow-up deadlines.'
        );
      }
    }


    const {
      error: profileError
    } = await sb
      .from('profiles')
      .update({
        active: false
      })
      .eq('id', fromId);

    if (profileError) {
      throw dbError(
        profileError,
        'Could not deactivate member.'
      );
    }
  },


  // -------------------------------------------------------------------
  // ACTIVITY
  // -------------------------------------------------------------------

  async log(
    text,
    actorId,
    actor
  ) {

    const {
      error
    } = await sb
      .from('activity_log')
      .insert({
        actor_id: actorId,
        actor,
        text
      });

    if (error) {
      throw dbError(
        error,
        'Could not record activity.'
      );
    }
  },


  // -------------------------------------------------------------------
  // CONTACT LOGS  (weekly touch record)
  // -------------------------------------------------------------------

  async logContact(companyId, { contacted, discussed, nextDate }, me) {
    const { error } = await sb.from('contact_logs').insert({
      company_id: companyId,
      logged_by: me?.id ?? null,
      logged_name: me?.name ?? null,
      contacted,
      discussed: discussed ?? '',
      next_date: nextDate || null
    });
    if (error) throw dbError(error, 'Could not save the log.');
  },

  async loadLogs(companyId) {
    const { data, error } = await sb.from('contact_logs')
      .select('*').eq('company_id', companyId).order('at', { ascending: false });
    if (error) throw dbError(error, 'Could not load contact history.');
    return (data ?? []).map((l) => ({
      id: l.id, by: l.logged_name, contacted: l.contacted,
      discussed: l.discussed, nextDate: l.next_date, at: l.at
    }));
  },

  // -------------------------------------------------------------------
  // NOTIFICATIONS  (in-app bell)
  // -------------------------------------------------------------------

  async loadNotifications(userId) {
    const { data, error } = await sb.from('notifications')
      .select('*').eq('user_id', userId).order('at', { ascending: false }).limit(60);
    if (error) return [];
    return (data ?? []).map((n) => ({
      id: n.id, kind: n.kind, text: n.text, companyId: n.company_id,
      read: n.read, at: n.at
    }));
  },

  async markNotif(id) {
    await sb.from('notifications').update({ read: true }).eq('id', id);
  },

  async markAllNotifs(userId) {
    await sb.from('notifications').update({ read: true })
      .eq('user_id', userId).eq('read', false);
  },

  // Admin nudge: send a log reminder straight to a member.
  async nudge(userId, text, companyId) {
    const { error } = await sb.from('notifications').insert({
      user_id: userId, kind: 'nudge', text, company_id: companyId ?? null
    });
    if (error) throw dbError(error, 'Could not send the reminder.');
  },

  // -------------------------------------------------------------------
  // PENDING LOGS  (companies not contacted in >= 10 days)
  // -------------------------------------------------------------------

  async loadPendingLogs() {
    const { data, error } = await sb.from('v_pending_logs')
      .select('*').order('days_since', { ascending: false });
    if (error) return [];
    return (data ?? []).map((r) => ({
      id: r.id, name: r.name, channel: r.channel, category: r.category,
      handler: r.handler ?? 'Unassigned', handlerId: r.handler_id,
      lastContacted: r.last_contacted, daysSince: r.days_since
    }));
  },

  // -------------------------------------------------------------------
  // REAL-TIME
  // -------------------------------------------------------------------

  subscribe(onChange) {

    return sb
      .channel('desk')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'companies'
        },
        onChange
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'items'
        },
        onChange
      )
      .subscribe();
  }

};
