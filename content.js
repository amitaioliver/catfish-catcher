// Catfish Catcher for LinkedIn
// Reads the profile you are viewing, scores common fake-account signals,
// and shows a badge next to the name. Nothing leaves your browser.
(() => {
  if (window.__prcLoaded) return;
  window.__prcLoaded = true;

  // The script also runs inside frames (manifest all_frames), but only does anything in the hidden
  // frame the feed uses to check a profile in the background. frameElement is null at the top level.
  let frameEl = null;
  try {
    frameEl = window.frameElement;
  } catch (e) {
    frameEl = null;
  }
  const IS_PROBE = !!(frameEl && frameEl.dataset && frameEl.dataset.prcProbe);
  if (frameEl && !IS_PROBE) return;

  // Chrome and Firefox both offer the promise-based extension API; Firefox calls it `browser`
  const ext = (() => {
    try {
      if (typeof browser !== 'undefined' && browser.storage) return browser;
      if (typeof chrome !== 'undefined' && chrome.storage) return chrome;
    } catch (e) {
      /* not running as an extension (e.g. tests) */
    }
    return null;
  })();

  // Requests are made as the LinkedIn page itself. In Firefox, content-script requests otherwise
  // come from the extension, so `content.fetch` is used there.
  const pageFetch = (() => {
    try {
      if (typeof content !== 'undefined' && content && typeof content.fetch === 'function') return content.fetch.bind(content);
    } catch (e) {
      /* not Firefox */
    }
    return (...a) => fetch(...a);
  })();

  // ---------- helpers ----------
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
  const SECTION_HEADINGS = [
    'About', 'Activity', 'Experience', 'Education', 'Licenses & certifications', 'Skills',
    'Recommendations', 'Projects', 'Volunteering', 'Honors & awards', 'Languages', 'Interests',
    'Featured', 'Courses', 'Publications', 'Organizations', 'Services', 'People you may know',
    'More profiles for you', 'Explore Premium profiles', 'Sales Insights', 'Causes', 'Patents',
    'Test scores',
  ];
  const BUZZWORDS = [
    'passionate about', 'data driven', 'data-driven', 'data backed', 'data-backed', 'insight driven',
    'insight-driven', 'insight-led', 'scalable', 'strategic', 'high quality', 'high-quality',
    'results-driven', 'results driven', 'leverage', 'synergy', 'dynamic', 'innovative',
    'talent intelligence', 'market intelligence', 'pipeline', 'relationship driven',
    'relationship-driven', 'long-term', 'end-to-end', 'cutting-edge', 'growth-oriented',
  ];
  // a "lure" is a job-style post that asks people to DM/comment but names no company and has no link
  const JOBISH_RE = /\b(wanted|hiring|looking for (a|an)|opportunity|open (role|position)|freelancer?s? needed)\b/i;
  // Sign-up links look like "first-last-1a2b3c4d" and are made from the name at the time.
  // Only these are compared: chosen links ("jdoe") and non-Latin names are skipped.
  function nameMismatch(name, slug) {
    if (!name || !slug || !/^[a-z]+(?:-[a-z]+)+-[0-9a-f]{6,}$/.test(slug)) return false;
    const plain = (x) => x.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const words = plain(name).split(/[^a-z]+/).filter((w) => w.length >= 3);
    if (!words.length || /[^\x00-\u024f\s.,'’()-]/.test(name)) return false;
    return !words.some((w) => slug.includes(w));
  }
  const DM_RE = /\b(dm me|message me|comment below|inbox me|send me a (dm|message)|drop a comment|reach out to me)\b/i;
  const NAMED_RE = /(https?:\/\/|lnkd\.in|\bView job\b|\bApply (here|now|at|via)\b|\bat [A-Z][\w&.-]+|@[A-Z])/;
  // "through Acme Labs", "for Acme Health", "join Northwind" - an organisation by name
  const ORG_RE = /\b(?:through|at|for|with|via|from|join|joining|on behalf of)\s+(?:the\s+)?([A-Z][\w&.'’-]*(?:\s+(?:&|and|of|[A-Z][\w&.'’-]*))*)/g;
  const ROLE_WORDS = /\b(researchers?|designers?|engineers?|developers?|managers?|recruiters?|freelancers?|consultants?|writers?|analysts?|marketers?|specialists?|UX|UI)$/i;

  function namesOrganisation(text, headline) {
    for (const m of text.matchAll(ORG_RE)) {
      const name = m[1].trim();
      if (name.split(/\s+/).length === 1 && name.length < 3) continue;
      if (ROLE_WORDS.test(name)) continue; // "for Senior Engineers" is a role, not an employer
      return true;
    }
    // the author's own company, when their headline names it as their employer
    // ("Founder, Acme Labs", "Designer at Acme", "CEO @ Northwind")
    const EMPLOYER_RE = /(?:\bat\s+|@\s*|\b(?:Founder|Co-Founder|CEO|Owner|Director|Partner|Head)\s*(?:,|of|at|@)\s*)([A-Z][\w&.'’ -]{2,40}?)(?=\s*(?:\||·|,|$))/g;
    const orgs = [...(headline || '').matchAll(EMPLOYER_RE)].map((m) => m[1].trim());
    const norm = (s) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]/g, '');
    const t = norm(text);
    return orgs.some((o) => norm(o).length >= 4 && t.includes(norm(o)));
  }

  function isLure(text, headline) {
    return !!text && JOBISH_RE.test(text) && DM_RE.test(text) && !NAMED_RE.test(text) && !namesOrganisation(text, headline);
  }
  const ACTIVITY_NOISE_RE = /\b(reposted this|commented on this|replied|likes this|celebrates this|supports this|loves this|finds this|is curious about this)\b/i;

  // a distinctive sentence from a post, for the copycat search
  function searchSentence(text, headline) {
    const candidate = lines(text).find(
      (l) => l.length >= 40 && l.length <= 200 && !l.includes('#') && !l.includes('|') && l !== headline && !/^[•\-–]/.test(l)
    );
    if (!candidate) return '';
    const clean = candidate.replace(/[“”"]/g, '').trim();
    // cut to ~80 chars on a word boundary so the quoted search still matches
    return clean.length <= 80 ? clean : clean.slice(0, 80).replace(/\s+\S*$/, '');
  }
  const copySearchUrl = (sentence) =>
    `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(`"${sentence}"`)}&sortBy=%22date_posted%22`;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, timeout = 4000, step = 150) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await wait(step);
    }
    return null;
  };
  const visible = (el) => !!el && el.getBoundingClientRect().width > 0;
  const lines = (t) => (t || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const monthsBetween = (a, b) => (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  const fmt = (d) => d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  const parseMonthYear = (s) => {
    const m = (s || '').match(new RegExp(`(${MONTH_RE})\\s+(\\d{4})`, 'i'));
    if (m) return new Date(+m[2], MONTHS[m[1].slice(0, 3).toLowerCase()], 1);
    const y = (s || '').match(/\b(19|20)\d{2}\b/);
    return y ? new Date(+y[0], 0, 1) : null;
  };

  // ---------- page reading ----------
  const profileSlug = () => {
    const m = location.pathname.match(/^\/in\/([^/]+)\/?(?:overlay\/.*)?$/);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const profileName = () =>
    document.title.replace(/^\(\d+\)\s*/, '').replace(/\s*\|\s*LinkedIn.*$/i, '').trim();
  const topCard = () => document.querySelector('main section');
  const getScroller = () => {
    let e = topCard();
    while (e && e !== document.body) {
      const oy = getComputedStyle(e).overflowY;
      if (/(auto|scroll)/.test(oy) && e.scrollHeight > e.clientHeight + 50) return e;
      e = e.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  };
  const nameEl = () => {
    const card = topCard();
    const name = profileName();
    if (!card || !name) return null;
    return (
      [...card.querySelectorAll('h1, h2')].find((e) => e.textContent.trim() === name) ||
      [...card.querySelectorAll('h1, h2')][0] ||
      null
    );
  };
  // read one profile section by its heading. Each section is its own <section> element whose
  // first line is the heading; reading the whole page instead would pick up the footer's "About" link.
  const sectionLines = (heading) => {
    for (const s of document.querySelectorAll('main section')) {
      const ls = lines(s.innerText);
      if (ls[0] === heading) return ls.slice(1);
    }
    // fallback for layouts where a section isn't wrapped in <section>: read the page text,
    // but only up to the footer
    const all = lines(document.querySelector('main')?.innerText);
    const footer = all.findIndex((l) => l === 'Accessibility' || /^LinkedIn Corporation/.test(l));
    // the footer starts with an "About" link just before "Accessibility"
    const cut = footer > 0 && all[footer - 1] === 'About' ? footer - 1 : footer;
    const body = cut < 0 ? all : all.slice(0, cut);
    const start = body.findIndex((l) => l === heading);
    if (start < 0) return null;
    const end = body.findIndex((l, i) => i > start && SECTION_HEADINGS.includes(l));
    return body.slice(start + 1, end < 0 ? undefined : end);
  };

  function readProfile() {
    const card = topCard();
    const cardLines = lines(card?.innerText);
    const name = profileName();
    const nameIdx = cardLines.indexOf(name);
    const nameParts = name.split(/\s+/).filter((w) => w.length > 1);
    const headline =
      cardLines
        .slice(nameIdx + 1)
        .find(
          (l) =>
            l.length > 3 &&
            !/^[·•]/.test(l) &&
            !/^(1st|2nd|3rd)/.test(l) &&
            !/^\(?(she|he|they|ella|él|elle|il)\s*\/\s*\w+\)?$/i.test(l) && // pronouns
            !(nameParts.length > 1 && nameParts.every((w) => l.includes(w))) // name variant, e.g. maiden name
        ) || '';
    const cardText = card?.innerText || '';
    const conn = cardText.match(/([\d,]+)\+?\s+connections/i);

    const exp = sectionLines('Experience');
    let earliestStart = null;
    let roleCount = 0;
    let firstCompanyLine = '';
    if (exp) {
      const rangeRe = new RegExp(`((?:${MONTH_RE}\\s+)?\\d{4})\\s*[-–]\\s*(present|(?:${MONTH_RE}\\s+)?\\d{4})`, 'i');
      exp.forEach((l) => {
        const m = l.match(rangeRe);
        if (m) {
          roleCount++;
          const d = parseMonthYear(m[1]);
          if (d && (!earliestStart || d < earliestStart)) earliestStart = d;
        }
      });
      firstCompanyLine = exp[1] || '';
    }

    const about = (sectionLines('About') || []).join(' ');
    const activity = sectionLines('Activity');

    // the recent posts the person wrote themselves (latest first), not reposts or posts they commented on
    const ownPosts = [];
    if (activity) {
      for (let i = 0; i < activity.length && ownPosts.length < 3; i++) {
        if (activity[i] !== name) continue;
        if (i > 0 && ACTIVITY_NOISE_RE.test(activity[i - 1])) continue;
        const block = [];
        for (let j = i + 1; j < activity.length; j++) {
          const l = activity[j];
          if (l === name || ACTIVITY_NOISE_RE.test(l) || /^(Show all|Load more)/i.test(l)) break;
          block.push(l);
        }
        if (block.length) ownPosts.push(block.join('\n'));
      }
    }
    const ownPost = ownPosts[0] || '';

    const photo =
      [...(card?.querySelectorAll('img') || [])].find((i) => name && (i.alt || '').includes(name.split(' ')[0])) || null;

    // one search sentence per recent post, so a copy further down their activity can be found too
    const postSentences = ownPosts
      .map((t, i) => ({ n: i + 1, s: searchSentence(t, headline) }))
      .filter((x, i, all) => x.s && all.findIndex((y) => y.s === x.s) === i);

    return {
      name,
      headline,
      connections: conn ? parseInt(conn[1].replace(/,/g, ''), 10) : null,
      connectionsPlus: /500\+\s+connections/i.test(cardText),
      hasMutuals: /mutual connection/i.test(cardText),
      earliestStart,
      roleCount,
      expLoaded: !!exp,
      firstCompanyLine,
      about,
      activityLoaded: !!activity,
      ownPost,
      slug: profileSlug(),
      hasRecommendations: !!sectionLines('Recommendations'),
      photoUrl: photo?.src || null,
      postSentences,
    };
  }

  // ---------- deep data (account age, verification, email) ----------
  const deepCache = new Map();

  function parseAboutDialog(text, data) {
    const m = text.match(/Joined LinkedIn\s*\n+\s*([A-Za-z]+\s+\d{4})/i);
    if (m) data.joined = parseMonthYear(m[1]);
    if (/doesn.t have any verifications/i.test(text)) data.verified = false;
    else if (/Verifications/i.test(text)) data.verified = true;
  }

  const findDialog = (re) =>
    [...document.querySelectorAll('[role="dialog"], dialog')].find((d) => visible(d) && re.test(d.innerText));

  async function closeDialog(dlg) {
    const btn = [...dlg.querySelectorAll('button')].find((b) =>
      /^(done|dismiss|close)$/i.test((b.innerText || b.getAttribute('aria-label') || '').trim()) ||
      /dismiss|close/i.test(b.getAttribute('aria-label') || '')
    );
    if (btn) btn.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await wait(500);
  }

  // Experience: one background request for the same page LinkedIn opens under
  // "Show all experiences". No scrolling, nothing on screen.
  const decode = (s) =>
    s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

  async function fetchExperience(slug) {
    const res = await pageFetch(new URL(`/in/${encodeURIComponent(slug)}/details/experience/`, location.origin).href, { credentials: 'include' });
    if (!res.ok) return null;
    const html = await res.text();
    // paragraphs in page order, with a LINK marker wherever an employer links its company page
    const ps = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>|href="[^"]*\/company\/[^"]*"/g)]
      .map((m) => (m[1] === undefined ? LINK : decode(m[1])))
      .filter(Boolean);
    const start = ps.indexOf('Experience');
    if (start < 0) return null;
    const STOP = /^(Why am I seeing this ad\?|More profiles for you|People you may know|About|Accessibility)$/;
    const end = ps.findIndex((l, i) => i > start && STOP.test(l));
    const exp = ps.slice(start + 1, end < 0 ? undefined : end);
    return { ...summariseExperience(exp.filter((l) => l !== LINK)), unlinkedRoles: unlinkedRoles(exp) };
  }

  const LINK = '\u0000link';
  // How many dated roles sit under an employer with no LinkedIn company page. A linked employer
  // shows its link just before the role, or before a group header ("QualEx", "15 yrs 10 mos")
  // that holds several roles. Errs towards "linked" when a group is followed by a single role.
  function unlinkedRoles(exp) {
    const rangeRe = new RegExp(`(?:${MONTH_RE}\\s+)?\\d{4}\\s*[-–]\\s*(?:present|(?:${MONTH_RE}\\s+)?\\d{4})`, 'i');
    let linkSeen = false;
    let groupLinked = null;
    let roles = 0;
    let unlinked = 0;
    for (const l of exp) {
      if (l === LINK) linkSeen = true;
      else if (/^(?:\d+ yrs?)?\s*(?:\d+ mos?)?$/.test(l) && /\d/.test(l)) {
        groupLinked = linkSeen;
        linkSeen = false;
      } else if (rangeRe.test(l)) {
        roles++;
        const linked = linkSeen || !!groupLinked;
        if (linkSeen) groupLinked = null;
        if (!linked) unlinked++;
        linkSeen = false;
      }
    }
    return { roles, unlinked };
  }

  function summariseExperience(exp) {
    const rangeRe = new RegExp(`((?:${MONTH_RE}\\s+)?\\d{4})\\s*[-–]\\s*(present|(?:${MONTH_RE}\\s+)?\\d{4})`, 'i');
    let earliestStart = null;
    let roleCount = 0;
    exp.forEach((l) => {
      const m = l.match(rangeRe);
      if (m) {
        roleCount++;
        const d = parseMonthYear(m[1]);
        if (d && (!earliestStart || d < earliestStart)) earliestStart = d;
      }
    });
    return { roleCount, earliestStart, firstCompanyLine: exp[1] || '' };
  }

  // LinkedIn's own panels are opened with this style in place, so they never appear on screen
  function hideOverlays(on) {
    const id = 'prc-hide-overlays';
    document.getElementById(id)?.remove();
    if (!on) return;
    const st = document.createElement('style');
    st.id = id;
    st.textContent = `
      [role="dialog"], dialog, [role="menu"], :has(> [role="menu"]), .artdeco-modal-overlay, .artdeco-dropdown__content
        { opacity: 0 !important; pointer-events: none !important; transition: none !important; animation: none !important; }
      dialog::backdrop { opacity: 0 !important; }`;
    document.head.appendChild(st);
  }

  async function readAboutThisMember(data, stillHere) {
    const card = topCard();
    const moreBtn = [...(card?.querySelectorAll('button') || [])].find((b) => b.innerText.trim() === 'More' && visible(b));
    if (!moreBtn) return;
    moreBtn.click();
    const item = await waitFor(() =>
      [...document.querySelectorAll('[role="menuitem"]')].find((e) => /About this (member|profile)/i.test(e.innerText))
    );
    if (!item || !stillHere()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    item.click();
    const dlg = await waitFor(() => findDialog(/Joined LinkedIn/i), 6000);
    if (dlg) {
      parseAboutDialog(dlg.innerText, data);
      await closeDialog(dlg);
    }
  }

  async function readContactEmail(data) {
    const ci = [...(topCard()?.querySelectorAll('a') || [])].find((a) => /overlay\/contact-info/.test(a.href));
    if (!ci) return;
    ci.click();
    const dlg = await waitFor(() => findDialog(/linkedin\.com\/in\//i), 6000);
    if (dlg) {
      const em = dlg.innerText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
      data.email = em ? em[0] : '';
      await closeDialog(dlg);
    }
  }

  // runs automatically when a profile opens: experience + account age + verification, all hidden
  async function backgroundCheck(slug) {
    const data = deepCache.get(slug) || {};
    deepCache.set(slug, data);
    const stillHere = () => profileSlug() === slug;

    if (!data.exp) {
      try {
        data.exp = await fetchExperience(slug);
      } catch (e) {
        /* fall back to whatever the page shows */
      }
    }
    if (!stillHere()) return;
    scheduleScan();

    if (!data.joined) {
      hideOverlays(true);
      try {
        await readAboutThisMember(data, stillHere);
      } finally {
        hideOverlays(false);
      }
    }
    data.autoDone = true;
  }

  // the contact email is only read when you ask (it opens the Contact info panel)
  async function emailCheck(slug) {
    const data = deepCache.get(slug) || {};
    deepCache.set(slug, data);
    hideOverlays(true);
    try {
      if (!data.joined) await readAboutThisMember(data, () => profileSlug() === slug);
      await readContactEmail(data);
    } finally {
      hideOverlays(false);
    }
    data.checked = true;
  }

  // passively capture the dialog if the user opens "About this member" themselves
  const startPassiveCapture = () => new MutationObserver(() => {
    const slug = profileSlug();
    if (!slug) return;
    const dlg = findDialog(/Joined LinkedIn/i);
    if (dlg) {
      const data = deepCache.get(slug) || {};
      if (!data.joined) {
        parseAboutDialog(dlg.innerText, data);
        deepCache.set(slug, data);
        scheduleScan();
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------- scoring ----------
  // Strong signals are what fake accounts actually share. Weak signals are common on real
  // profiles too, so they only count once a strong signal is present. Trust signals always
  // pull the score down.
  function score(p, d) {
    return finalize(collect(p, d), d);
  }

  function collect(p, d) {
    const strong = [];
    const weak = [];
    const trust = [];
    const pending = [];
    const now = new Date();

    // --- account age (needs the full check) ---
    if (d.joined) {
      const age = monthsBetween(d.joined, now);
      // the newer the account, the fishier: under 1 month +5, 1–2 +4, 3–5 +3, 6–11 +2
      if (age < 12) strong.push({ pts: age < 1 ? 5 : age < 3 ? 4 : age < 6 ? 3 : 2, newAccount: true, text: age === 0 ? `Account created this month (${fmt(d.joined)})` : `Account created ${fmt(d.joined)}, ${age} month${age === 1 ? '' : 's'} ago` });
      else if (age >= 36) trust.push({ pts: -3, text: `On LinkedIn since ${d.joined.getFullYear()}` });
      else trust.push({ pts: -1, text: `On LinkedIn since ${fmt(d.joined)}` });
      if (p.earliestStart && age < 18 && monthsBetween(p.earliestStart, d.joined) >= 12) {
        strong.push({ pts: 3, text: `Work history goes back to ${fmt(p.earliestStart)}, but the account was only created ${fmt(d.joined)}` });
      }
    } else {
      pending.push('account age');
    }

    // --- name doesn't match the name LinkedIn put in the profile link at sign-up ---
    if (nameMismatch(p.name, p.slug)) {
      strong.push({ pts: 2, text: `Name doesn't match the profile link (/in/${p.slug}), so the account may have been renamed` });
    }

    // --- employers with no LinkedIn company page ---
    const ul = p.unlinkedRoles;
    if (ul && ul.unlinked >= 2 && ul.unlinked * 2 >= ul.roles) {
      const text = `${ul.unlinked} of ${ul.roles} roles are at employers with no LinkedIn company page`;
      if (d.joined && monthsBetween(d.joined, now) < 12) strong.push({ pts: 2, text });
      else weak.push({ pts: 1, text });
    }

    // --- lure post (their own latest post) ---
    if (isLure(p.ownPost, p.headline)) {
      strong.push({ pts: 2, text: 'Latest post reads like a job offer and asks for DMs or comments, but names no company, link or job listing' });
    }

    // --- weak signals ---
    if (d.verified === false) weak.push({ pts: 1, text: "No LinkedIn verification (many real members aren't verified)" });
    else if (d.verified === undefined) pending.push('verification');

    if (d.email && /@(gmail|yahoo|hotmail|outlook|live|proton|protonmail|aol|mail|gmx|yandex)\./i.test(d.email) && /\d{2,}@/.test(d.email)) {
      weak.push({ pts: 1, text: 'Free email address with numbers in contact info' });
    }

    const segs = p.headline.split(/\s*\|\s*/).filter(Boolean);
    const namesEmployer = /(\bat\s+[A-Z]|@\s*[A-Z]|\bEx-|\bformerly\b)/.test(p.headline);
    if (segs.length >= 4 && !namesEmployer) weak.push({ pts: 1, text: `Headline stacks ${segs.length} keyword phrases and names no employer` });

    if (p.expLoaded) {
      if (p.roleCount <= 2 && /self[- ]?employed|freelance/i.test(p.firstCompanyLine)) {
        weak.push({ pts: 1, text: 'Only freelance or self-employed work, with no named clients' });
      }
      if (p.roleCount === 0) weak.push({ pts: 1, text: 'No dated work history' });
    }

    const lower = p.about.toLowerCase();
    const buzz = BUZZWORDS.filter((b) => lower.includes(b)).length;
    if (buzz >= 6) weak.push({ pts: 1, text: `About section reads like template text (${buzz} buzzwords)` });

    if (p.connections !== null && !p.connectionsPlus && p.connections < 50) weak.push({ pts: 1, text: `Only ${p.connections} connections` });

    // --- trust signals ---
    if (d.verified === true) trust.push({ pts: -2, text: 'Has a LinkedIn verification' });
    // on an account under 6 months old, many connections or typed-in roles don't reassure
    const veryNew = d.joined && monthsBetween(d.joined, new Date()) < 6;
    if (p.connectionsPlus && veryNew) weak.push({ pts: 1, text: '500+ connections on an account under 6 months old' });
    if (p.connectionsPlus && !veryNew) trust.push({ pts: -1, text: '500+ connections' });
    if (p.expLoaded && p.roleCount >= 4 && !veryNew) trust.push({ pts: -1, text: `${p.roleCount} dated roles in work history` });
    if (p.hasRecommendations) trust.push({ pts: -1, text: 'Has recommendations from others' });

    return { strong, weak, trust, pending };
  }

  function finalize({ strong, weak, trust, pending }, d) {
    // a new account on its own is normal (students, career changers); it needs company
    const hasStrong = strong.some((s) => !s.newAccount) || strong.length >= 2;
    const counted = [...strong, ...(hasStrong ? weak : []), ...trust].map(({ pts, text }) => ({ pts, text }));
    const total = counted.reduce((s, x) => s + x.pts, 0);
    const level = !hasStrong || total < 3 ? 'low' : total >= 6 ? 'high' : 'caution';

    return {
      total,
      level,
      signals: counted,
      notes: hasStrong ? [] : weak, // shown greyed out: present, but not counted on their own
      pending,
      checked: !!(d && d.joined),
    };
  }

  if (window.__PRC_TEST) window.__prcTest = { score, unlinkedRoles, nameMismatch, LINK, parseMonthYear, isLure, searchSentence, flagsFor, combined, postedWindow, copyRelations, recordCopies, fingerprint, collect, get tidySeen() { return tidySeen; }, get store() { return store; }, get storeReady() { return storeReady; } };

  // =====================================================================
  // ---------- storage ----------
  // LinkedIn clears the page's localStorage, so everything lives in the extension's own storage
  // (storage.local), mirrored in memory for instant reads.
  const mem = {};
  const hasExtStorage = !!(ext && ext.storage && ext.storage.local);
  const storeReady = hasExtStorage
    ? Promise.resolve()
        .then(() => ext.storage.local.get(null))
        .then((items) => Object.assign(mem, items || {}))
        .catch(() => {})
    : Promise.resolve();
  if (hasExtStorage) {
    try {
      // keep tabs in sync (e.g. a setting changed in another tab)
      ext.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        for (const [k, { newValue }] of Object.entries(changes)) {
          if (newValue === undefined) delete mem[k];
          else mem[k] = newValue;
        }
      });
    } catch (e) {
      /* ignore */
    }
  }
  const store = {
    get(key, fallback) {
      return key in mem ? mem[key] : fallback;
    },
    set(key, v) {
      mem[key] = v;
      if (!hasExtStorage) return;
      try {
        Promise.resolve(ext.storage.local.set({ [key]: v })).catch(() => {});
      } catch (e) {
        /* extension reloaded: in-memory copy still works for this page */
      }
    },
    remove(key) {
      delete mem[key];
      if (!hasExtStorage) return;
      try {
        Promise.resolve(ext.storage.local.remove(key)).catch(() => {});
      } catch (e) {
        /* ignore */
      }
    },
  };
  const setting = (key, def) => {
    const v = store.get('prc:set:' + key, null);
    return v === null ? def : v;
  };
  const setSetting = (key, v) => store.set('prc:set:' + key, v);

  // ---------- UI ----------
  const COLORS = {
    low: { dot: '#1f9d55', bg: '#e8f6ee', fg: '#145c34', label: 'Nothing fishy' },
    unchecked: { dot: '#7c8b97', bg: '#eef1f4', fg: '#38434d', label: 'Not checked yet' },
    caution: { dot: '#d98200', bg: '#fff4e0', fg: '#7a4a00', label: 'A bit fishy' },
    high: { dot: '#d93025', bg: '#fdecea', fg: '#8a1c13', label: 'Very fishy' },
  };

  const FOOT = 'Signs to look at, not proof. Nothing leaves your browser.';

  // reasons split by direction, so it's clear what raises and what lowers the estimate
  const signalLine = (s) =>
    el('li', {}, el('span', { class: `pts ${s.pts > 0 ? 'pos' : 'neg'}` }, `${s.pts > 0 ? '+' : ''}${s.pts}`), el('span', {}, s.text));
  function signalLists(signals) {
    const up = signals.filter((s) => s.pts > 0);
    const down = signals.filter((s) => s.pts < 0);
    return el(
      'div',
      {},
      up.length ? el('div', { class: 'notes-title' }, 'Fishy signs:') : null,
      up.length ? el('ul', {}, up.map(signalLine)) : null,
      down.length ? el('div', { class: 'notes-title' }, 'Reassuring signs:') : null,
      down.length ? el('ul', {}, down.map(signalLine)) : null
    );
  }
  const notesList = (notes) =>
    el(
      'div',
      { class: 'notes' },
      el('div', { class: 'notes-title' }, 'Common on real profiles too, so not counted on their own:'),
      el('ul', {}, notes.map((s) => el('li', {}, el('span', { class: 'pts' }, '·'), el('span', {}, s.text))))
    );

  let host = null;
  let shadow = null;
  let panelOpen = false;
  let busy = false; // a check you started from the panel
  let autoRunningFor = null; // slug of the profile being checked in the background
  let panelEl = null;
  let lastSignature = '';

  const autoEnabled = () => setting('profileAuto', true);
  const setAuto = (on) => setSetting('profileAuto', on);

  function ensureHost() {
    const nameNode = nameEl();
    if (!nameNode) return false;
    // on some profiles the name is wrapped in a link; sit beside the link so clicks don't navigate
    const anchor = nameNode.closest('a') || nameNode;
    if (host && host.isConnected && host.previousElementSibling === anchor) return true;
    if (host) host.remove();
    host = document.createElement('span');
    host.id = 'prc-host';
    host.style.cssText = 'display:inline-block;position:relative;margin:6px 0 2px;z-index:5;';
    shadow = host.attachShadow({ mode: 'open' });
    anchor.insertAdjacentElement('afterend', host);
    lastSignature = '';
    return true;
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    .pill { display:inline-flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px;
            font-size:13px; font-weight:600; cursor:pointer; line-height:1.4; border:1px solid transparent; }
    .pill:hover { filter: brightness(0.97); }
    .dot { width:9px; height:9px; border-radius:50%; }
    .muted { font-weight:400; opacity:.8; }
    .panel { position:fixed; inset:auto; margin:0; width:340px; max-height:70vh; overflow:auto; z-index:2147483647; background:#fff; color:#1d2226;
             border:1px solid #d0d5da; border-radius:10px; box-shadow:0 6px 24px rgba(0,0,0,.14);
             padding:14px; font-size:13px; line-height:1.45; }
    h3 { margin:0 0 2px; font-size:14px; }
    .score { color:#5e6b77; margin-bottom:10px; }
    ul { margin:0 0 10px; padding:0; list-style:none; }
    li { display:flex; gap:8px; padding:5px 0; border-top:1px solid #eef0f2; }
    li:first-child { border-top:none; }
    .pts { min-width:26px; font-weight:700; text-align:right; flex-shrink:0; }
    .pos { color:#b3261e; } .neg { color:#1f9d55; }
    .pending { color:#5e6b77; font-size:12px; margin-bottom:10px; }
    button { width:100%; padding:8px; border:none; border-radius:999px; background:#0a66c2; color:#fff;
             font-weight:600; font-size:13px; cursor:pointer; margin-bottom:10px; }
    button:disabled { background:#8fb5dc; cursor:default; }
    button.secondary { background:#fff; color:#0a66c2; border:1px solid #0a66c2; }
    .spin { width:9px; height:9px; border-radius:50%; border:2px solid currentColor; border-right-color:transparent;
            animation: prc-spin .8s linear infinite; }
    @keyframes prc-spin { to { transform: rotate(360deg); } }
    label.auto { display:flex; align-items:center; gap:6px; color:#38434d; font-size:12px; margin:0 0 8px; cursor:pointer; }
    label.auto input { margin:0; }
    .links { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:10px; }
    a { color:#0a66c2; text-decoration:none; font-weight:600; }
    a:hover { text-decoration:underline; }
    .foot { color:#5e6b77; font-size:11px; border-top:1px solid #eef0f2; padding-top:8px; }
    .empty { color:#5e6b77; margin:0 0 10px; }
    .notes { color:#5e6b77; font-size:12px; margin-bottom:10px; }
    .notes-title { margin-bottom:2px; }
    .sect { font-weight:700; font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#38434d; margin:10px 0 4px; }
    .notes li { padding:2px 0; border-top:none; }
  `;

  // tiny DOM builder (LinkedIn sanitises innerHTML, so build elements directly)
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }

  // The panel opens in the browser's "top layer" (a popover), which sits above everything on the
  // page regardless of LinkedIn's layers. It's positioned under the badge and follows it on scroll.
  function panelPosition() {
    const rect = host.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 348));
    const below = rect.bottom + 6;
    const room = window.innerHeight - below - 8;
    // flip above the badge if there's little room below
    const top = room < 220 && rect.top > window.innerHeight / 2 ? Math.max(8, rect.top - 6 - Math.min(window.innerHeight * 0.7, 480)) : below;
    return `top:${Math.round(top)}px;left:${Math.round(left)}px`;
  }

  function placePanel() {
    if (!panelEl || !host) return;
    const rect = host.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      panelOpen = false;
      scan();
      return;
    }
    panelEl.style.cssText = panelPosition();
  }

  async function runCheck(fn) {
    if (busy) return;
    busy = true;
    lastSignature = '';
    scan();
    try {
      await fn(profileSlug());
    } finally {
      busy = false;
      lastSignature = '';
      scan();
    }
  }

  function render(p, d, r) {
    const checking = busy || autoRunningFor === currentSlug;
    const sig = JSON.stringify([r, panelOpen, checking, !!d.checked, !!d.joined, autoEnabled(), p.photoUrl, p.postSentences]);
    if (sig === lastSignature) return;
    lastSignature = sig;

    const c = COLORS[r.level === 'low' && !r.checked ? 'unchecked' : r.level];
    const n = r.signals.filter((s) => s.pts > 0).length;
    const summary = checking
      ? 'checking…'
      : r.level === 'low'
        ? r.checked ? 'checked' : 'quick scan'
        : `${n} signal${n === 1 ? '' : 's'}`;
    const searchLinks =
      p.postSentences.length === 1 && p.postSentences[0].n === 1
        ? [el('a', { href: copySearchUrl(p.postSentences[0].s), target: '_blank', rel: 'noopener' }, 'Search for copies of latest post')]
        : p.postSentences.length
          ? [
              el('span', {}, 'Search for copies:'),
              ...p.postSentences.map(({ n, s }) =>
                el('a', { href: copySearchUrl(s), target: '_blank', rel: 'noopener', title: s }, n === 1 ? 'latest post' : `post ${n}`)
              ),
            ]
          : [];
    const lensUrl = p.photoUrl ? `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(p.photoUrl)}` : null;

    const pill = el(
      'span',
      {
        class: 'pill',
        title: 'Catfish Catcher',
        style: `background:${c.bg};color:${c.fg};border-color:${c.dot}33`,
        onclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          panelOpen = !panelOpen;
          scan();
        },
      },
      checking ? el('span', { class: 'spin', style: `color:${c.dot}` }) : el('span', { class: 'dot', style: `background:${c.dot}` }),
      c.label,
      el('span', { class: 'muted' }, `· ${summary}`)
    );

    let panel = null;
    if (panelOpen) {
      panel = el(
        'div',
        { class: 'panel', popover: 'manual', style: panelPosition(), onclick: (e) => e.stopPropagation() },
        el('h3', {}, c.label),
        el(
          'div',
          { class: 'score' },
          r.level === 'low' && !r.signals.some((s) => s.pts > 0)
            ? 'Nothing fishy found.'
            : `Score ${r.total}. A bit fishy from 3, very fishy from 6. Needs a strong warning sign.`
        ),
        r.signals.length ? signalLists(r.signals) : null,
        r.notes.length ? notesList(r.notes) : null,
        r.pending.length ? el('div', { class: 'pending' }, `Not checked yet: ${r.pending.join(', ')}`) : null,
        checking
          ? el('button', { disabled: true }, 'Checking account age & verification…')
          : !d.joined
            ? el('button', { onclick: (e) => { e.preventDefault(); e.stopPropagation(); runCheck(backgroundCheck); } }, 'Check account age & verification')
            : !d.checked
              ? el(
                  'button',
                  { class: 'secondary', onclick: (e) => { e.preventDefault(); e.stopPropagation(); runCheck(emailCheck); } },
                  'Check contact email'
                )
              : null,
        searchLinks.length ? el('div', { class: 'links' }, searchLinks) : null,
        lensUrl ? el('div', { class: 'links' }, el('a', { href: lensUrl, target: '_blank', rel: 'noopener' }, 'Reverse-search photo')) : null,
        el(
          'label',
          { class: 'auto' },
          el('input', {
            type: 'checkbox',
            checked: autoEnabled(),
            onchange: (e) => {
              e.stopPropagation();
              setAuto(e.target.checked);
              lastSignature = '';
              scan();
            },
          }),
          'Check account age when a profile opens'
        ),
        el('div', { class: 'foot' }, FOOT)
      );
    }

    shadow.replaceChildren(el('style', {}, CSS), pill, panel || '');
    panelEl = panel;
    if (panel) {
      try {
        panel.showPopover(); // top layer: always above the page
      } catch (e) {
        /* older browsers fall back to position:fixed with a max z-index */
      }
    }
  }

  function startProfileUI() {
    document.addEventListener(
      'scroll',
      (e) => {
        if (panelOpen && e.target !== host) placePanel(); // scrolling inside the panel retargets to host
      },
      true
    );
    window.addEventListener('resize', () => panelOpen && placePanel());

    document.addEventListener('click', () => {
      if (panelOpen && !busy && !autoRunningFor) {
        panelOpen = false;
        scan();
      }
    });

    new MutationObserver((muts) => {
      if (busy) return;
      if (muts.every((m) => host && (m.target === host || host.contains(m.target)))) return;
      scheduleScan();
    }).observe(document.body, { childList: true, subtree: true });

    setInterval(() => {
      if (profileSlug() !== currentSlug) scan();
    }, 1000);

    scan();
  }

  // ---------- main loop ----------
  const isOwnProfile = () =>
    /[?&]isSelfProfile=true\b/.test(location.search) || location.pathname.startsWith('/in/me/') ||
    /\b(Add profile section|Enhance profile)\b/.test(topCard()?.innerText || '');

  let currentSlug = null;

  function scan() {
    if (IS_PROBE) return;
    const slug = profileSlug();
    if (slug !== currentSlug) {
      currentSlug = slug;
      panelOpen = false;
      if (host) host.remove();
      host = null;
    }
    if (!slug) return;
    if (isOwnProfile()) {
      if (host) host.remove();
      host = null;
      return;
    }
    if (!ensureHost()) return;
    const p = readProfile();
    const d = deepCache.get(slug) || {};
    // the fetched Experience page is complete; the profile page only shows the first few roles
    if (d.exp) Object.assign(p, d.exp, { expLoaded: true });
    maybeStartAuto(slug, d); // before render, so the badge shows "checking…" straight away
    render(p, d, score(p, d));
  }

  function maybeStartAuto(slug, d) {
    if (!autoEnabled() || d.autoDone || d.joined || autoRunningFor || busy) return;
    if (nameEl()?.textContent.trim() !== profileName()) return; // profile still loading
    autoRunningFor = slug;
    lastSignature = '';
    setTimeout(async () => {
      try {
        if (profileSlug() === slug) await backgroundCheck(slug);
      } catch (e) {
        /* leave the quick scan as is */
      } finally {
        const data = deepCache.get(slug) || {};
        data.autoDone = true;
        deepCache.set(slug, data);
        autoRunningFor = null;
        lastSignature = '';
        scan();
      }
    }, 1200); // let LinkedIn finish rendering the profile first
  }

  let timer = null;
  function scheduleScan() {
    clearTimeout(timer);
    timer = setTimeout(scan, 600);
  }

  // ---------- background profile check (hidden frame) ----------
  // The feed never shows account age, so a flagged author's profile is loaded in an invisible
  // frame where this same script runs the profile check and reports back. LinkedIn counts it as
  // a profile view, so it only happens for flagged posts.
  async function runProbe() {
    let slugKey = '';
    try {
      slugKey = window.frameElement.dataset.prcSlug || '';
    } catch (e) {
      return;
    }
    // the result is written onto the <iframe> element itself: plain DOM, which behaves the same
    // in Chrome and Firefox (window messaging between extension scripts does not)
    const send = (payload) => {
      try {
        frameEl.setAttribute('data-prc-result', JSON.stringify({ slug: slugKey, ...payload }));
      } catch (e) {
        /* parent gone */
      }
    };
    try {
      const ready = await waitFor(() => {
        const n = nameEl();
        return n && profileName() && n.textContent.trim() === profileName();
      }, 25000, 300);
      if (!ready) return send({ error: "the profile didn't load" });
      await wait(1000);
      const slug = profileSlug();
      await backgroundCheck(slug);
      const d = deepCache.get(slug) || {};
      const p = readProfile();
      if (d.exp) Object.assign(p, d.exp, { expLoaded: true });
      send({
        parts: collect(p, d),
        joined: d.joined ? d.joined.getTime() : null,
        name: p.name,
        isConnection: /[·•]\s*1st\b/.test(topCard()?.innerText || ''),
      });
    } catch (e) {
      send({ error: String(e && e.message ? e.message : e) });
    }
  }

  function probe(slugKey) {
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.dataset.prcProbe = '1';
      f.dataset.prcSlug = slugKey;
      f.setAttribute('aria-hidden', 'true');
      f.tabIndex = -1;
      // on screen (so LinkedIn renders it normally) but fully transparent and click-through
      f.style.cssText =
        'position:fixed;left:0;top:0;width:1200px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1;';
      let to = null;
      const mo = new MutationObserver(() => {
        const raw = f.getAttribute('data-prc-result');
        if (!raw) return;
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          return;
        }
        if (!data || data.slug !== slugKey) return;
        finish();
        if (data.error) reject(new Error(data.error));
        else resolve(data);
      });
      const finish = () => {
        mo.disconnect();
        clearTimeout(to);
        f.remove();
      };
      mo.observe(f, { attributes: true, attributeFilter: ['data-prc-result'] });
      to = setTimeout(() => {
        finish();
        reject(new Error('timed out'));
      }, 45000);
      f.src = `/in/${slugKey}/`;
      document.body.appendChild(f);
    });
  }

  // results are kept for a week so the same author isn't re-checked every time they post
  const RESULT_TTL = 7 * 24 * 3600 * 1000;
  const getResult = (slugKey) => {
    const r = store.get('prc:results', {})[slugKey];
    return r && Date.now() - r.t < RESULT_TTL ? r : null;
  };
  const saveResult = (slugKey, data) => {
    const all = store.get('prc:results', {});
    const now = Date.now();
    for (const k of Object.keys(all)) if (now - all[k].t > RESULT_TTL) delete all[k];
    all[slugKey] = { t: now, parts: data.parts, joined: data.joined, name: data.name, isConnection: data.isConnection };
    store.set('prc:results', all);
  };

  // one check at a time; automatic ones are spaced out and capped per hour
  const AUTO_GAP = 20000;
  const AUTO_PER_HOUR = 10;
  const queue = [];
  let probing = null;
  const failures = {};
  const checkedThisPage = new Set();
  const autoAllowed = () => {
    const log = store.get('prc:autolog', []).filter((t) => Date.now() - t < 3600 * 1000);
    return log.length < AUTO_PER_HOUR && (!log.length || Date.now() - log[log.length - 1] > AUTO_GAP);
  };
  const noteAuto = () => {
    const log = store.get('prc:autolog', []).filter((t) => Date.now() - t < 3600 * 1000);
    log.push(Date.now());
    store.set('prc:autolog', log);
  };

  function requestCheck(slugKey, auto) {
    if (probing === slugKey || queue.some((q) => q.slugKey === slugKey)) return;
    if (auto) noteAuto();
    delete failures[slugKey];
    queue.push({ slugKey, auto });
    pump();
  }

  async function pump() {
    if (probing || !queue.length) return;
    const job = queue.shift();
    probing = job.slugKey;
    renderFeedSoon();
    try {
      saveResult(job.slugKey, await probe(job.slugKey));
      checkedThisPage.add(job.slugKey);
    } catch (e) {
      failures[job.slugKey] = e.message || String(e);
    } finally {
      probing = null;
      renderFeedSoon();
      setTimeout(pump, 500);
    }
  }

  // ---------- copycat detection ----------
  // A short fingerprint of each post's opening text, kept only in this browser for 30 days.
  // The same text from two different authors is the clearest sign of a scam network.
  // Each post text gets its own storage entry ("prc:seen:<fingerprint>"), so two LinkedIn tabs
  // never overwrite each other's records. Every read goes to the shared in-memory copy, which is
  // kept in sync across tabs.
  const SEEN_TTL = 30 * 24 * 3600 * 1000;
  const SEEN_MAX = 2000; // both kinds together
  // "prc:seen:" holds the full opening (word-for-word copies), "prc:open:" just the first ~100
  // characters (copies that keep the opening but reword the rest)
  const seenKey = (fp, kind = 'seen') => `prc:${kind}:${fp}`;
  const getSeen = (fp, kind) => {
    const r = store.get(seenKey(fp, kind), null);
    return r && Date.now() - r.t < SEEN_TTL ? r : null;
  };
  function tidySeen() {
    // move records from the old single list (v0.4 to v0.6.1) into separate entries
    const old = store.get('prc:seen', null);
    if (old && typeof old === 'object') {
      for (const [fp, rec] of Object.entries(old)) if (!store.get(seenKey(fp), null)) store.set(seenKey(fp), rec);
      store.remove('prc:seen');
    }
    const now = Date.now();
    const keys = Object.keys(mem).filter((k) => k.startsWith('prc:seen:') || k.startsWith('prc:open:'));
    keys.filter((k) => now - (mem[k]?.t || 0) > SEEN_TTL).forEach((k) => store.remove(k));
    const live = keys.filter((k) => k in mem).sort((a, b) => mem[a].t - mem[b].t);
    live.slice(0, Math.max(0, live.length - SEEN_MAX)).forEach((k) => store.remove(k));
  }

  function fingerprint(text, size = 200) {
    const n = text
      .toLowerCase()
      .replace(/…\s*(more|see more)\s*$/i, '')
      .replace(/[^\p{L}\p{N} ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (n.length < 120) return null; // too short to be distinctive
    const s = n.slice(0, size);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(36);
  }

  // Records this author's posting time for the text and works out, for every other author seen with
  // the same text, who posted first. Once an order is known it is stored on the text's record
  // ("order"), so every post with that text gives the same answer even if one side's time is
  // missing. Older records may hold just a name and no time.
  function copyRelations(fp, info, kind) {
    const rec = getSeen(fp, kind) || { t: Date.now(), a: {}, order: {} };
    rec.a = rec.a || {};
    rec.order = rec.order || {};
    let changed = false;

    const prev = rec.a[info.slugKey];
    const prevObj = prev && typeof prev === 'object' && prev.from ? prev : null;
    let mine = info.posted ? { from: info.posted.from, to: info.posted.to } : null;
    if (prevObj && mine && prevObj.to >= mine.from && mine.to >= prevObj.from) {
      mine = { from: Math.max(prevObj.from, mine.from), to: Math.min(prevObj.to, mine.to) }; // seen again: narrow
    } else if (prevObj && !mine) {
      mine = { from: prevObj.from, to: prevObj.to };
    }
    const entry = { n: info.name, from: mine ? mine.from : null, to: mine ? mine.to : null };
    if (!prev || JSON.stringify(prev) !== JSON.stringify(entry)) {
      rec.a[info.slugKey] = entry;
      changed = true;
    }

    const out = { copiedFrom: [], copiedBy: [], unclear: [], mine };
    for (const [k, v] of Object.entries(rec.a)) {
      if (k === info.slugKey) continue;
      const other = typeof v === 'object' ? v : { n: v, from: null, to: null };
      const person = { slugKey: k, name: other.n, from: other.from, to: other.to };
      // a stored decision wins; otherwise compare the two posting windows and store the result
      let order = rec.order[`${k}<${info.slugKey}`] ? 'theyFirst' : rec.order[`${info.slugKey}<${k}`] ? 'meFirst' : null;
      if (!order && mine && other.from) {
        if (other.to < mine.from) order = 'theyFirst';
        else if (mine.to < other.from) order = 'meFirst';
        if (order) {
          rec.order[order === 'theyFirst' ? `${k}<${info.slugKey}` : `${info.slugKey}<${k}`] = 1;
          changed = true;
        }
      }
      if (order === 'theyFirst') out.copiedFrom.push(person);
      else if (order === 'meFirst') out.copiedBy.push(person);
      else out.unclear.push(person);
    }

    if (changed) {
      rec.t = Date.now();
      store.set(seenKey(fp, kind), rec);
    }
    return out;
  }

  // Sets info.rel (word-for-word copies) and info.reworded (same opening, the rest reworded).
  // People already matched word for word are left out of the reworded list.
  function recordCopies(info, fp) {
    const none = { copiedFrom: [], copiedBy: [], unclear: [] };
    info.rel = fp ? copyRelations(fp, info) : none;
    const ofp = fp && fingerprint(info.text, 100);
    const open = ofp ? copyRelations(ofp, info, 'open') : none;
    const same = new Set([...info.rel.copiedFrom, ...info.rel.copiedBy, ...info.rel.unclear].map((x) => x.slugKey));
    const notSame = (xs) => xs.filter((x) => !same.has(x.slugKey));
    info.reworded = { copiedFrom: notSame(open.copiedFrom), copiedBy: notSame(open.copiedBy), unclear: notSame(open.unclear) };
    return info;
  }

  // ---------- reading feed posts ----------
  const feedActive = () => /^\/(feed|search\/results\/content)\b/.test(location.pathname);
  const isFeedLabel = (e) => e.childElementCount === 0 && e.textContent.trim() === 'Feed post';

  function feedPosts() {
    const labels = [...document.querySelectorAll('main span, main h2')].filter(isFeedLabel);
    return labels.map((lab) => {
      let p = lab;
      while (p.parentElement && p.parentElement.tagName !== 'MAIN') {
        const n = [...p.parentElement.querySelectorAll('span, h2')].filter(isFeedLabel).length;
        if (n > 1) break;
        p = p.parentElement;
      }
      return p;
    });
  }

  // LinkedIn shows post age as "3h", "1d", "2w", "3mo", "1yr" (rounded down), so each post's
  // time is a window: "1d" means posted between 24 and 48 hours ago.
  const AGE_UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, yr: 31536e6, y: 31536e6 };
  function postedWindow(headerLines) {
    for (const l of headerLines) {
      const m = l.match(/^(\d+)\s*(mo|yr|s|m|h|d|w|y)\b/);
      if (!m) continue;
      const n = +m[1];
      const unit = AGE_UNITS[m[2]];
      const now = Date.now();
      return { from: now - (n + 1) * unit, to: now - n * unit, label: m[1] + m[2] };
    }
    return null;
  }
  // how long ago, in LinkedIn's style ("1 day", "3 hours"), from the stored window so it stays
  // right on later days
  const ageText = (w) => {
    if (!w || !w.to) return 'some time';
    const diff = Math.max(0, Date.now() - w.to);
    const steps = [['year', AGE_UNITS.yr], ['month', AGE_UNITS.mo], ['week', AGE_UNITS.w], ['day', AGE_UNITS.d], ['hour', AGE_UNITS.h], ['minute', AGE_UNITS.m]];
    for (const [name, ms] of steps) {
      const n = Math.floor(diff / ms);
      if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
    return 'under a minute';
  };

  function parsePost(post) {
    const ls = lines(post.innerText);
    const di = ls.findIndex((l) => /^[•·]\s*(1st|2nd|3rd\+?)\b/.test(l));
    if (di < 1) return null; // company pages, promoted posts, your own posts
    const degree = ls[di].match(/(1st|2nd|3rd\+?)/)[1];
    const name = ls[di - 1];
    const headline = ls[di + 1] || '';
    const link = [...post.querySelectorAll('a[href*="/in/"]')].find(
      (a) => lines(a.innerText)[0] === name || (a.getAttribute('aria-label') || '').includes(name)
    );
    const m = link && link.getAttribute('href').match(/\/in\/([^/?#]+)/);
    if (!m) return null;
    const box = post.querySelector('[data-testid="expandable-text-box"]');
    const text = box ? box.innerText.replace(/…\s*more\s*$/i, '').trim() : '';
    const hasJobCard = /\bView job\b/.test(post.innerText);
    const posted = postedWindow(ls.slice(di + 1, di + 6));
    return { slugKey: m[1], name, headline, degree, text, box, hasJobCard, posted, href: `/in/${m[1]}/` };
  }

  // ---------- feed badges ----------
  const postState = new WeakMap();
  let feedPanelFor = null; // the post whose panel is open
  let fpHost = null;
  let fpShadow = null;

  // What the post itself shows. "post" flags describe the post (copied / lure); their points feed the
  // risk estimate for the author, but copying alone is not treated as proof of anything.
  const names = (ps) => {
    const n = ps.map((p) => p.name);
    return n.length <= 2 ? n.join(' and ') : `${n.slice(0, 2).join(', ')} and ${n.length - 2} more`;
  };
  function flagsFor(info) {
    const flags = [];
    const { copiedFrom, unclear } = info.rel;
    if (copiedFrom.length) {
      const first = copiedFrom.reduce((a, b) => (a.to < b.to ? a : b));
      flags.push({
        kind: 'copy',
        tag: 'copied post',
        pts: 2,
        strong: true,
        text:
          `Copied word for word from ${names(copiedFrom)}` +
          (first.to ? `, who posted it ${ageText(first)} ago.` : ', who posted it first.') +
          (info.rel.mine && info.rel.mine.to ? ` This one was posted ${ageText(info.rel.mine)} ago.` : ''),
      });
    } else if (unclear.length) {
      flags.push({
        kind: 'copy',
        tag: 'possibly copied post',
        pts: 1,
        strong: false,
        text: `Same text, word for word, as a post by ${names(unclear)}. Can't tell which was posted first.`,
      });
    } else if (info.reworded && (info.reworded.copiedFrom.length || info.reworded.unclear.length)) {
      // weaker than a word-for-word copy: only counts once a stronger warning sign is present
      const rw = info.reworded;
      const first = rw.copiedFrom.length ? rw.copiedFrom.reduce((a, b) => (a.to < b.to ? a : b)) : null;
      flags.push({
        kind: 'copy',
        tag: first ? 'reworded copy' : 'possibly reworded copy',
        pts: 1,
        strong: false,
        text: first
          ? `Same opening sentence as ${rw.copiedFrom.length > 1 ? 'posts' : 'a post'} by ${names(rw.copiedFrom)}` +
            (first.to ? `, ${rw.copiedFrom.length > 1 ? 'the earliest ' : ''}posted ${ageText(first)} ago` : ', posted earlier') +
            '; the rest is reworded. That was the earliest seen in your feed, and an older original may exist.'
          : `Same opening sentence as ${rw.unclear.length > 1 ? 'posts' : 'a post'} by ${names(rw.unclear)}; the rest is reworded. Can't tell which was posted first.`,
      });
    }
    if (isLure(info.text + (info.hasJobCard ? '\nView job' : ''), info.headline)) {
      flags.push({
        kind: 'lure',
        tag: 'job lure',
        pts: 2,
        strong: true,
        text: 'Reads like a job offer and asks for DMs or comments, but names no company, link or job listing',
      });
    }
    return flags;
  }

  function combined(flags, res) {
    if (!res) return null;
    const hasLure = flags.some((f) => f.kind === 'lure');
    const fromPost = (strong) => flags.filter((f) => f.strong === strong).map(({ pts, text }) => ({ pts, text: `This post: ${text}` }));
    return finalize(
      {
        ...res.parts,
        strong: [...res.parts.strong.filter((s) => !(hasLure && /reads like a job offer/.test(s.text))), ...fromPost(true)],
        weak: [...res.parts.weak, ...fromPost(false)],
      },
      { joined: res.joined }
    );
  }

  function badgeFor(st) {
    const { info, flags } = st;
    const res = getResult(info.slugKey);
    const r = combined(flags, res);
    const running = probing === info.slugKey || queue.some((q) => q.slugKey === info.slugKey);
    const tags = flags.map((f) => f.tag).join(' · ');
    const first = info.name.split(' ')[0];
    if (running) return { c: COLORS.caution, label: cap(tags), sub: `checking ${first}…`, spin: true, r, tags };
    if (r) return { c: COLORS[r.level], label: COLORS[r.level].label, sub: tags, r, tags };
    return { c: COLORS.caution, label: cap(tags), sub: failures[info.slugKey] ? "profile couldn't be checked" : 'profile not checked', r: null, tags };
  }
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  function renderBadge(st) {
    const b = badgeFor(st);
    const sig = JSON.stringify([b.label, b.sub, b.spin, b.c.dot]);
    if (st.sig === sig && st.host.isConnected) return;
    st.sig = sig;
    st.shadow.replaceChildren(
      el('style', {}, CSS),
      el(
        'span',
        {
          class: 'pill',
          id: 'pill',
          title: 'Click to see the signs',
          style: `background:${b.c.bg};color:${b.c.fg};border-color:${b.c.dot}33`,
          onclick: (e) => {
            e.preventDefault();
            e.stopPropagation();
            feedPanelFor = feedPanelFor === st ? null : st;
            renderFeedPanel();
          },
        },
        b.spin ? el('span', { class: 'spin', style: `color:${b.c.dot}` }) : el('span', { class: 'dot', style: `background:${b.c.dot}` }),
        b.label,
        el('span', { class: 'muted' }, `· ${b.sub}`)
      )
    );
  }

  function ensureFeedPanelHost() {
    if (fpHost && fpHost.isConnected) return;
    fpHost = document.createElement('div');
    fpHost.id = 'prc-feed-panel';
    fpShadow = fpHost.attachShadow({ mode: 'open' });
    document.body.appendChild(fpHost);
  }

  function feedPanelPosition(anchor) {
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - 348));
    const below = rect.bottom + 6;
    const top = window.innerHeight - below < 260 && rect.top > window.innerHeight / 2 ? Math.max(8, rect.top - 6 - Math.min(window.innerHeight * 0.7, 480)) : below;
    return `top:${Math.round(top)}px;left:${Math.round(left)}px`;
  }

  // "First" only means first among the copies that passed through your feed
  function originNote(info) {
    const { copiedFrom, copiedBy } = info.rel;
    if (copiedFrom.length) {
      const first = copiedFrom.reduce((a, b) => (a.to < b.to ? a : b));
      return el('div', { class: 'pending' }, `${first.name}'s post is the earliest copy seen in your feed. It may itself be copied from an older post that never appeared there.`);
    }
    if (copiedBy.length) {
      return el('div', { class: 'pending' }, 'This is the earliest copy seen in your feed, but an older original may exist that never appeared there.');
    }
    return null;
  }

  function renderFeedPanel() {
    ensureFeedPanelHost();
    const st = feedPanelFor;
    if (!st || !st.host.isConnected) {
      feedPanelFor = null;
      fpShadow.replaceChildren();
      return;
    }
    const { info, flags } = st;
    const b = badgeFor(st);
    const res = getResult(info.slugKey);
    const running = !!b.spin;
    const failed = failures[info.slugKey];
    const r = b.r;

    const checkBtn = running
      ? el('button', { disabled: true }, `Checking ${info.name}…`)
      : el(
          'button',
          {
            class: res ? 'secondary' : '',
            onclick: (e) => {
              e.stopPropagation();
              requestCheck(info.slugKey, false);
              renderFeedSoon();
            },
          },
          res ? 'Check the profile again' : failed ? 'Try the profile check again' : `Check ${info.name}'s profile`
        );

    // the profile's own signals, without the post flags (those are listed under "This post")
    const profileOnly = r ? r.signals.filter((s) => !s.text.startsWith('This post: ')) : [];
    const copiedByNote = info.rel.copiedBy.length || info.reworded.copiedBy.length
      ? el(
          'div',
          { class: 'pending' },
          [
            info.rel.copiedBy.length ? `${names(info.rel.copiedBy)} later posted the same text.` : '',
            info.reworded.copiedBy.length ? `${names(info.reworded.copiedBy)} later posted a reworded version with the same opening.` : '',
          ].filter(Boolean).join(' ')
        )
      : null;
    const sentence = searchSentence(info.text, info.headline);

    const panel = el(
      'div',
      { class: 'panel', popover: 'manual', style: feedPanelPosition(st.host), onclick: (e) => e.stopPropagation() },
      el('h3', {}, b.label),
      el('div', { class: 'score' }, el('a', { href: info.href, target: '_blank', rel: 'noopener' }, info.name), ` · ${info.degree}`),
      el('div', { class: 'sect' }, 'This post'),
      el('ul', {}, flags.map((f) => el('li', {}, el('span', { class: 'pts pos' }, `+${f.pts}`), el('span', {}, f.text)))),
      flags.some((f) => f.kind === 'copy') ? el('div', { class: 'pending' }, 'Real people copy viral posts too. A copy is a sign, not proof.') : null,
      copiedByNote,
      originNote(info),
      sentence ? el('div', { class: 'links' }, el('a', { href: copySearchUrl(sentence), target: '_blank', rel: 'noopener', title: sentence }, 'Search for copies of this post')) : null,
      el('div', { class: 'sect' }, 'Their profile'),
      r
        ? el(
            'div',
            {},
            signalLists(profileOnly),
            r.notes.filter((s) => !s.text.startsWith('This post: ')).length ? notesList(r.notes.filter((s) => !s.text.startsWith('This post: '))) : null,
            el('div', { class: 'score' }, `Score ${r.total} (checked ${new Date(res.t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}). A bit fishy from 3, very fishy from 6.`)
          )
        : el(
            'div',
            { class: 'pending' },
            failed
              ? `Couldn't check their profile (${failed}).`
              : running
                ? 'Checking their profile in the background…'
                : 'Not checked yet. The check reads their account age, verification and work history.'
          ),
      checkBtn,
      el('div', { class: 'pending' }, 'LinkedIn counts each check as a profile view.'),
      el(
        'label',
        { class: 'auto' },
        el('input', {
          type: 'checkbox',
          checked: setting('feedAuto', true),
          onchange: (e) => {
            e.stopPropagation();
            setSetting('feedAuto', e.target.checked);
          },
        }),
        'Check fishy posts from people outside my network'
      ),
      el(
        'label',
        { class: 'auto' },
        el('input', {
          type: 'checkbox',
          checked: setting('feedConnections', false),
          onchange: (e) => {
            e.stopPropagation();
            setSetting('feedConnections', e.target.checked);
            renderFeedSoon();
          },
        }),
        'Also flag posts from my connections (never checked automatically)'
      ),
      el('div', { class: 'foot' }, FOOT)
    );
    fpShadow.replaceChildren(el('style', {}, CSS), panel);
    try {
      panel.showPopover();
    } catch (e) {
      /* fixed position with max z-index as a fallback */
    }
  }

  function placeFeedPanel() {
    if (!feedPanelFor || !fpShadow) return;
    const panel = fpShadow.querySelector('.panel');
    if (!panel) return;
    const rect = feedPanelFor.host.getBoundingClientRect();
    if (!feedPanelFor.host.isConnected || rect.bottom < 0 || rect.top > window.innerHeight) {
      feedPanelFor = null;
      renderFeedPanel();
      return;
    }
    panel.style.cssText = feedPanelPosition(feedPanelFor.host);
  }

  function scanFeed() {
    if (!feedActive()) {
      if (feedPanelFor) {
        feedPanelFor = null;
        renderFeedPanel();
      }
      return;
    }
    const includeConnections = setting('feedConnections', false);
    for (const post of feedPosts()) {
      const info = parsePost(post);
      if (!info) continue;
      const fp = fingerprint(info.text);
      const key = `${info.slugKey}|${fp || info.text.slice(0, 60)}`;
      let st = postState.get(post);
      if (!st || st.key !== key) {
        st?.host?.remove();
        st = { key, host: null, shadow: null, sig: '' };
        postState.set(post, st);
      }
      // record every post (connections too) so copies across accounts are spotted
      recordCopies(info, fp);
      st.info = info;
      st.flags = flagsFor(info);

      const skip = info.degree === '1st' && !includeConnections;
      if (!st.flags.length || skip) {
        if (st.host) st.host.remove();
        st.host = null;
        continue;
      }

      if (!st.host || !st.host.isConnected) {
        st.host = document.createElement('div');
        st.host.className = 'prc-feed-badge';
        st.host.style.cssText = 'display:block;margin:4px 16px 6px;';
        st.shadow = st.host.attachShadow({ mode: 'open' });
        st.sig = '';
        const anchor = info.box ? info.box.closest('div') || info.box : null;
        if (anchor && anchor.parentElement) anchor.parentElement.insertBefore(st.host, anchor);
        else post.appendChild(st.host);
      }

      // automatic full check: only flagged posts, only people outside your network
      if (
        info.degree !== '1st' &&
        setting('feedAuto', true) &&
        !getResult(info.slugKey) &&
        !checkedThisPage.has(info.slugKey) &&
        !failures[info.slugKey] &&
        probing !== info.slugKey &&
        !queue.some((q) => q.slugKey === info.slugKey) &&
        autoAllowed()
      ) {
        requestCheck(info.slugKey, true);
      }
      renderBadge(st);
    }
    if (feedPanelFor) renderFeedPanel();
  }

  let feedTimer = null;
  function renderFeedSoon() {
    clearTimeout(feedTimer);
    feedTimer = setTimeout(scanFeed, 300);
  }

  function startFeed() {
    new MutationObserver((muts) => {
      if (muts.every((m) => (fpHost && fpHost.contains(m.target)) || m.target.closest?.('.prc-feed-badge'))) return;
      renderFeedSoon();
    }).observe(document.body, { childList: true, subtree: true });
    document.addEventListener('scroll', () => placeFeedPanel(), true);
    window.addEventListener('resize', () => placeFeedPanel());
    document.addEventListener('click', () => {
      if (feedPanelFor) {
        feedPanelFor = null;
        renderFeedPanel();
      }
    });
    setInterval(() => feedActive() && renderFeedSoon(), 5000); // keeps "checking…" badges current
    renderFeedSoon();
  }

  // ---------- start ----------
  if (IS_PROBE) {
    runProbe();
  } else {
    storeReady.then(() => {
      tidySeen();
      startPassiveCapture();
      startProfileUI();
      startFeed();
    });
  }
})();
