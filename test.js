// Copy-detection self-check: node test.js
// Version A and version B share the first sentence; B rewords everything after it.
const assert = require('assert');
const fs = require('fs');

const noop = () => {};
global.window = global;
window.__PRC_TEST = true;
global.location = { pathname: '/feed/', search: '', origin: 'https://www.linkedin.com' };
global.document = { title: '', addEventListener: noop, querySelector: () => null, querySelectorAll: () => [], body: {}, head: { appendChild: noop } };
global.MutationObserver = class { observe() {} };
global.setInterval = noop;
eval(fs.readFileSync(__dirname + '/content.js', 'utf8'));
const t = window.__prcTest;

const OPEN = 'Last week I offered a fully remote job to someone who had been out of work for months, at a better salary than they asked for.';
const A = `${OPEN}\nCalls like that are the best part of my job.\nYou could hear the relief: no moving away, no leaving family behind.\nKeep going. Your next yes might be closer than you think 🫶`;
const B = `${OPEN}\nHonestly, nothing beats making that phone call.\nNo relocation. Better pay. Finally, something that worked out.\nI hope more of you hear “you're hired” soon. ❤️`;

const H = 36e5;
const ago = (h) => ({ from: Date.now() - (h + 1) * H, to: Date.now() - h * H });
const post = (slugKey, name, text, hours) => {
  const info = { slugKey, name, text, headline: '', hasJobCard: false, posted: ago(hours) };
  t.recordCopies(info, t.fingerprint(text));
  return { info, flags: t.flagsFor(info) };
};

t.storeReady.then(() => {
  const alex = post('alex', 'Alex Moreno', A, 24 * 7);
  const blake = post('blake', 'Blake Chen', A, 24 * 6);
  const casey = post('casey', 'Casey Novak', B, 24);
  // trailing edits ("Follow …", a different emoji) still count as word for word
  const drew = post('drew', 'Drew Patel', B.replace('❤️', '❤') + '\nFollow Drew Patel 🇮🇳', 1);

  assert.deepStrictEqual(alex.flags, []);
  assert.deepStrictEqual(blake.flags.map((f) => [f.tag, f.pts, f.strong]), [['copied post', 2, true]]);
  assert.deepStrictEqual(casey.flags.map((f) => [f.tag, f.pts, f.strong]), [['reworded copy', 1, false]]);
  assert.match(casey.flags[0].text, /^Same opening sentence as posts by Alex Moreno and Blake Chen, the earliest posted 1 week ago; the rest is reworded/);
  assert.deepStrictEqual(drew.flags.map((f) => f.tag), ['copied post']); // word-for-word wins over reworded

  // Alex, seen again, gets notes only (no points)
  const again = post('alex', 'Alex Moreno', A, 24 * 7);
  assert.deepStrictEqual(again.flags, []);
  assert.deepStrictEqual(again.info.reworded.copiedBy.map((x) => x.slugKey), ['casey', 'drew']);

  // the +1 is a weak signal: alone it leaves the estimate low, with a stronger sign it counts
  const parts = (strong) => ({ strong, weak: [], trust: [], pending: [] });
  assert.strictEqual(t.combined(casey.flags, { parts: parts([]), joined: null }).signals.length, 0);
  const withNew = t.combined(casey.flags, { parts: parts([{ pts: 3, text: 'A strong sign' }]), joined: null });
  assert.strictEqual(withNew.total, 4);

  // search sentence: first usable line, cut on a word boundary
  assert.strictEqual(t.searchSentence(B, ''), 'Last week I offered a fully remote job to someone who had been out of work for');

  // very new account: verification still counts, connections and roles don't reassure
  const monthsAgo = (m) => { const x = new Date(); x.setDate(1); x.setMonth(x.getMonth() - m); return x; };
  const profile = { headline: '', expLoaded: true, roleCount: 5, firstCompanyLine: '', about: '', connections: null, connectionsPlus: true, hasRecommendations: false, ownPost: '' };
  const fresh = t.score(profile, { joined: monthsAgo(1), verified: true });
  assert.deepStrictEqual(fresh.signals.map((s) => s.pts), [4, -2]); // the +1 for fast connections is weak: not counted without a strong sign
  assert.strictEqual(fresh.level, 'low'); // a new account alone needs another strong sign
  const older = t.score(profile, { joined: monthsAgo(8), verified: true });
  assert.deepStrictEqual(older.signals.map((s) => s.pts), [2, -2, -1, -1]);

  // employers with no company page: one linked freelance role, then a group of 4 unlinked roles
  const L = t.LINK;
  assert.deepStrictEqual(t.unlinkedRoles([L, L, 'QA Engineer', 'Freelancer · Freelance', 'Oct 2026 - Present · 2 mos',
    'Acme Testing', '15 yrs 10 mos', 'Principal Test Engineer', 'Oct 2020 - Present · 6 yrs 2 mos', 'Test Engineer', 'Jun 2015 - Oct 2020 · 5 yrs 5 mos',
    'Tester', 'Feb 2012 - Jun 2015 · 3 yrs 5 mos', 'Intern', 'Feb 2011 - Feb 2012 · 1 yr 1 mo']), { roles: 5, unlinked: 4 });
  assert.deepStrictEqual(t.unlinkedRoles([L, L, 'Co-chair', 'Example Foundation', '2000 – Present', L, 'Founder', 'Example Energy', '2015 – Present']), { roles: 2, unlinked: 0 });

  // renamed account: sign-up link made from another name
  assert.strictEqual(t.nameMismatch('Jamie Rivera', 'maria-lopez-41a7b0441'), true);
  assert.strictEqual(t.nameMismatch('Jamie Rivera', 'jamie-rivera-41a7b0441'), false);
  assert.strictEqual(t.nameMismatch('José Núñez', 'jose-nunez-1b2c3d4e'), false);
  assert.strictEqual(t.nameMismatch('Jamie Rivera', 'jrivera'), false); // chosen link

  const renamed = { ...profile, unlinkedRoles: { roles: 5, unlinked: 4 }, name: 'Jamie Rivera', slug: 'maria-lopez-41a7b0441' };
  const all = t.score(renamed, { joined: monthsAgo(1), verified: true });
  assert.deepStrictEqual(all.signals.map((s) => s.pts), [4, 2, 2, 1, -2]);
  assert.strictEqual(all.level, 'high');

  console.log('ok');
  process.exit(0);
}).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
