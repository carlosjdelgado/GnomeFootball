// Unit tests for lib/event-detector.js — run with: gjs -m tests/unit/event-detector.test.js
// detectEvents / pruneLiveState are pure (no I/O); pickLogo runs for real but is
// deterministic here since the fixtures carry no team logos.

import { detectEvents, pruneLiveState } from '../../lib/event-detector.js';
import { EVENT_TYPE, MATCH_STATE } from '../../lib/constants.js';

let failures = 0;
function check(name, cond) {
    if (cond) {
        print(`  ok   ${name}`);
    } else {
        print(`  FAIL ${name}`);
        failures++;
    }
}
function eq(name, got, want) {
    check(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
        JSON.stringify(got) === JSON.stringify(want));
}

// Every event type enabled, so gating never hides an event unless a test asks.
function allEnabled() {
    const e = {};
    for (const t of Object.values(EVENT_TYPE))
        e[t] = true;
    return e;
}

function makeEvent({
    id = 'M1', state = MATCH_STATE.IN, period = 1, homeScore = 0, awayScore = 0,
    statusType = {}, date = null,
} = {}) {
    return {
        id,
        leagueSlug: 'esp.1',
        leagueName: 'LaLiga',
        date: date ?? new Date().toISOString(),
        status: { period, type: { state, ...statusType } },
        competitions: [{
            competitors: [
                { id: '10', homeAway: 'home', score: String(homeScore),
                  team: { displayName: 'Home', abbreviation: 'HOM', logos: [] } },
                { id: '20', homeAway: 'away', score: String(awayScore),
                  team: { displayName: 'Away', abbreviation: 'AWY', logos: [] } },
            ],
        }],
    };
}

// A non-null previous snapshot, so the cold-start branch is skipped.
function prevState(o = {}) {
    return {
        state: MATCH_STATE.IN, period: 1, homeScore: 0, awayScore: 0,
        seenPlayIds: [], seenGoals: {},
        shootoutAnnounced: false, extraTimeAnnounced: false,
        halfTimeAnnounced: false, reminderAnnounced: false,
        ...o,
    };
}

const goalPlay = (id, teamId = '10', player = 'Striker') => ({
    id, scoringPlay: true, type: { text: 'Goal', id: '70' },
    team: { id: teamId }, clock: { displayValue: "10'" },
    athletesInvolved: [{ displayName: player }],
});
const cardPlay = (id, text, teamId = '10') => ({
    id, type: { text, id: '93' }, team: { id: teamId },
    clock: { displayValue: "30'" }, athletesInvolved: [{ displayName: 'Defender' }],
});
const subPlay = (id, teamId = '10') => ({
    id, type: { text: 'Substitution', id: '99' }, team: { id: teamId },
    clock: { displayValue: "60'" },
    participants: [{ athlete: { displayName: 'In' } }, { athlete: { displayName: 'Out' } }],
});

const types = list => list.map(e => e.type);

// --- cold-start suppression -------------------------------------------------
print('cold-start suppression');
{
    const r = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, homeScore: 1 }),
        summary: { keyEvents: [goalPlay('g1')] },
        previousState: null,
        enabledEvents: allEnabled(),
    });
    eq('no-events', r.events.length, 0);
    eq('absorbs-state', r.nextState.state, 'in');
    eq('baseline-play-recorded', r.nextState.seenPlayIds.length, 1);
    eq('seenGoals-empty', r.nextState.seenGoals, {});
    eq('reminder-marked-moot', r.nextState.reminderAnnounced, true);
}

// --- match start / end ------------------------------------------------------
print('match start / end');
{
    const start = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN }),
        summary: {}, previousState: prevState({ state: MATCH_STATE.PRE }),
        enabledEvents: allEnabled(),
    });
    check('match-start', types(start.events).includes(EVENT_TYPE.MATCH_START));

    const end = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.POST }),
        summary: {}, previousState: prevState({ state: MATCH_STATE.IN }),
        enabledEvents: allEnabled(),
    });
    check('match-end', types(end.events).includes(EVENT_TYPE.MATCH_END));

    // No transition → no start event.
    const noChange = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN }),
        summary: {}, previousState: prevState({ state: MATCH_STATE.IN }),
        enabledEvents: allEnabled(),
    });
    check('no-restart', !types(noChange.events).includes(EVENT_TYPE.MATCH_START));
}

// --- halftime, second half, extra time, penalties ---------------------------
print('phase transitions');
{
    const ht = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, statusType: { id: '23' } }),
        summary: {}, previousState: prevState(),
        enabledEvents: allEnabled(),
    });
    check('halftime', types(ht.events).includes(EVENT_TYPE.HALF_TIME_END));
    eq('halftime-marked', ht.nextState.halfTimeAnnounced, true);

    // Once announced, it does not fire again.
    const htAgain = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, statusType: { id: '23' } }),
        summary: {}, previousState: prevState({ halfTimeAnnounced: true }),
        enabledEvents: allEnabled(),
    });
    check('halftime-once', !types(htAgain.events).includes(EVENT_TYPE.HALF_TIME_END));

    const second = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, period: 2 }),
        summary: {}, previousState: prevState({ period: 1 }),
        enabledEvents: allEnabled(),
    });
    check('second-half', types(second.events).includes(EVENT_TYPE.SECOND_HALF_START));

    const et = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, period: 3 }),
        summary: {}, previousState: prevState({ period: 2 }),
        enabledEvents: allEnabled(),
    });
    check('extra-time', types(et.events).includes(EVENT_TYPE.EXTRA_TIME));

    const pens = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, period: 5 }),
        summary: {}, previousState: prevState({ period: 4 }),
        enabledEvents: allEnabled(),
    });
    check('penalties', types(pens.events).includes(EVENT_TYPE.PENALTIES));
}

// --- goals: emit, record, dedup ---------------------------------------------
print('goals');
{
    const r = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, homeScore: 1 }),
        summary: { keyEvents: [goalPlay('g1', '10', 'Vinicius')] },
        previousState: prevState(),
        enabledEvents: allEnabled(),
    });
    const goals = r.events.filter(e => e.type === EVENT_TYPE.GOAL);
    eq('one-goal', goals.length, 1);
    eq('goal-player', goals[0].playerName, 'Vinicius');
    eq('goal-recorded', r.nextState.seenGoals['g1']?.teamSide, 'home');

    // Same play already seen → not re-emitted.
    const dedup = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, homeScore: 1 }),
        summary: { keyEvents: [goalPlay('g1', '10', 'Vinicius')] },
        previousState: prevState({ seenPlayIds: ['g1'], homeScore: 1,
            seenGoals: { g1: { teamSide: 'home', playerName: 'Vinicius', minute: "10'" } } }),
        enabledEvents: allEnabled(),
    });
    eq('goal-dedup', dedup.events.filter(e => e.type === EVENT_TYPE.GOAL).length, 0);
}

// --- cards & substitutions --------------------------------------------------
print('cards & substitutions');
{
    const yellow = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN }),
        summary: { keyEvents: [cardPlay('c1', 'Yellow Card')] },
        previousState: prevState(), enabledEvents: allEnabled(),
    });
    check('yellow', types(yellow.events).includes(EVENT_TYPE.YELLOW_CARD));

    const red = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN }),
        summary: { keyEvents: [cardPlay('c2', 'Red Card')] },
        previousState: prevState(), enabledEvents: allEnabled(),
    });
    check('red', types(red.events).includes(EVENT_TYPE.RED_CARD));

    const secondYellow = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN }),
        summary: { keyEvents: [cardPlay('c3', 'Second Yellow Card')] },
        previousState: prevState(), enabledEvents: allEnabled(),
    });
    check('second-yellow-is-red', types(secondYellow.events).includes(EVENT_TYPE.RED_CARD));

    const sub = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN }),
        summary: { keyEvents: [subPlay('s1')] },
        previousState: prevState(), enabledEvents: allEnabled(),
    });
    const subs = sub.events.filter(e => e.type === EVENT_TYPE.SUBSTITUTION);
    eq('substitution', subs.length, 1);
    eq('sub-players', [subs[0].playerIn, subs[0].playerOut], ['In', 'Out']);
}

// --- goal disallowed (VAR): goal vanished + score dropped -------------------
print('goal disallowed');
{
    const r = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, homeScore: 0 }), // was 1
        summary: { keyEvents: [] },                                          // goal gone
        previousState: prevState({
            homeScore: 1,
            seenGoals: { g1: { teamSide: 'home', playerName: 'Bellingham', minute: "10'" } },
        }),
        enabledEvents: allEnabled(),
    });
    const disallowed = r.events.filter(e => e.type === EVENT_TYPE.GOAL_DISALLOWED);
    eq('disallowed-emitted', disallowed.length, 1);
    eq('disallowed-player', disallowed[0].playerName, 'Bellingham');
}

// --- enabled gating: disabled type is suppressed but still recorded ----------
print('enabled gating');
{
    const enabled = allEnabled();
    enabled[EVENT_TYPE.GOAL] = false;
    const r = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.IN, homeScore: 1 }),
        summary: { keyEvents: [goalPlay('g1')] },
        previousState: prevState(), enabledEvents: enabled,
    });
    eq('goal-suppressed', r.events.filter(e => e.type === EVENT_TYPE.GOAL).length, 0);
    // Still recorded so it won't fire if the toggle is later turned on.
    check('still-seen', r.nextState.seenPlayIds.includes('g1'));
}

// --- pre-match reminder -----------------------------------------------------
print('pre-match reminder');
{
    const soon = new Date(Date.now() + 20 * 60000).toISOString();
    const inWindow = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.PRE, date: soon }),
        summary: {}, previousState: prevState({ state: MATCH_STATE.PRE }),
        enabledEvents: allEnabled(), reminderLeadMinutes: 30,
    });
    const reminders = inWindow.events.filter(e => e.type === EVENT_TYPE.MATCH_REMINDER);
    eq('reminder-fires', reminders.length, 1);
    eq('reminder-has-kickoff', typeof reminders[0].kickoffMs, 'number');
    eq('reminder-marked', inWindow.nextState.reminderAnnounced, true);

    // Outside the lead window → no reminder.
    const far = new Date(Date.now() + 90 * 60000).toISOString();
    const outOfWindow = detectEvents({
        scoreboardEvent: makeEvent({ state: MATCH_STATE.PRE, date: far }),
        summary: {}, previousState: prevState({ state: MATCH_STATE.PRE }),
        enabledEvents: allEnabled(), reminderLeadMinutes: 30,
    });
    eq('reminder-not-yet', outOfWindow.events.filter(e => e.type === EVENT_TYPE.MATCH_REMINDER).length, 0);
}

// --- pruneLiveState ---------------------------------------------------------
print('pruneLiveState');
{
    const now = Math.floor(Date.now() / 1000);
    const pruned = pruneLiveState({
        fresh: { lastUpdated: now },
        stale: { lastUpdated: now - 3 * 60 * 60 }, // 3h old, past the 2h default
    });
    check('keeps-fresh', 'fresh' in pruned);
    check('drops-stale', !('stale' in pruned));
}

print('');
if (failures > 0) {
    print(`${failures} failure(s)`);
    imports.system.exit(1);
} else {
    print('all tests passed');
}
