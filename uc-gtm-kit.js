/* ============================================================================
 * EUD-4042 / CTS-2487 — consent_status early emit test stand
 *
 * Reproduces a customer GTM setup and instruments it, so the order of dataLayer
 * events, the timing of the consent_status push relative to the CMP's own
 * network calls, and the state of the ucGcmStatus snapshot are all visible
 * without DevTools.
 *
 * The page drives it in two phases, because the GTM container snippet is pasted
 * into the HTML verbatim the way Google's install instructions require:
 *
 *   <script>window.UC_STAND_PAGE = { name: 'Home', ecom: [ … ] };</script>
 *   <script src="uc-gtm-kit.js"></script>   <- phase 1: dataLayer recorder,
 *                                              then Consent Mode v2 defaults
 *   … the GTM container snippet, verbatim …
 *   <script>window.ucStand.start();</script> <- phase 2: CMP loader, then the
 *                                               eCommerce events
 *
 * Phase 1 has to run first: the recorder must own dataLayer.push before
 * anything pushes, and Consent Mode defaults must precede the container.
 *
 * Config resolution for every option: ?query param  >  localStorage  >  default.
 * A query param is persisted, so it only has to be passed once.
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ config */

  var DEFAULTS = {
    // PR 1628 build carrying the EUD-4042 fix. The sandbox API domain is baked
    // into this bundle at build time (.env.pr), so it always talks to sandbox
    // for settings/cmpData — but consent SAVES still follow the data-sandbox
    // flag below, and the snapshot is written on save, so keep sandbox on.
    loader: 'https://web.cmp.usercentrics-sandbox.eu/ui/pr/1628/loader.js',
    settingsId: '',
    sandbox: '1',
    pixel: '000000000000000',
    // DPS name exactly as spelled in the Admin Interface — the consent_status
    // payload keys are service names, so the simulated consent-gated tag looks
    // this one up. Empty -> fall back to the marketing category.
    service: '',
    // ?gpc=1 shims navigator.globalPrivacyControl, the same way the repo's dev
    // harness does (packages/ui/cmp/src/public/test/index.ts), so the GPC guard
    // can be exercised without browser flags or extensions. Not persisted.
    gpc: '',
  };

  var LS_PREFIX = 'uc-stand:';
  var UC_KEYS = ['ucString', 'ucData', 'ucGcmStatus', 'ucSdkCombinedCmpData', 'ucAppState', 'ucUiData'];

  function lsGet(k, dflt) {
    try {
      var v = localStorage.getItem(LS_PREFIX + k);
      return v === null || v === '' ? dflt : v;
    } catch (e) {
      return dflt;
    }
  }
  function lsSet(k, v) {
    try {
      localStorage.setItem(LS_PREFIX + k, v);
    } catch (e) {}
  }

  var NOT_PERSISTED = { gpc: true }; // per-load toggles, must not stick

  var query = new URLSearchParams(location.search);
  var cfg = {};
  Object.keys(DEFAULTS).forEach(function (key) {
    var fromQuery = query.get(key);
    if (fromQuery !== null) {
      if (!NOT_PERSISTED[key]) lsSet(key, fromQuery);
      cfg[key] = fromQuery;
    } else {
      cfg[key] = NOT_PERSISTED[key] ? DEFAULTS[key] : lsGet(key, DEFAULTS[key]);
    }
  });
  // `loader` accepts two shorthands on top of a full URL.
  if (cfg.loader === 'pr') cfg.loader = DEFAULTS.loader;
  if (cfg.loader === 'prod') cfg.loader = 'https://web.cmp.usercentrics.eu/ui/loader.js';
  cfg.sandbox = cfg.sandbox === '1' || cfg.sandbox === 'true';

  var PAGE = window.UC_STAND_PAGE || { name: 'unnamed', ecom: [] };

  // GPC shim — installed before anything reads the signal, and before the CMP
  // loader is injected, so the SDK sees it during init.
  if (cfg.gpc === '1') {
    try {
      navigator.__defineGetter__('globalPrivacyControl', function () {
        return true;
      });
    } catch (e) {
      try {
        Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, get: function () { return true; } });
      } catch (e2) {}
    }
  }

  /* --------------------------------------------------- state at page load ---
   * Snapshotted before the CMP runs, so the panel can tell a first visit
   * (nothing cached -> no early emit expected, AC1) from a returning visit
   * (snapshot present -> early emit expected, AC2). The CMP overwrites
   * ucGcmStatus during this very page load, so reading it later would lie.  */

  function readJson(key) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  var TAMPER_FLAG = 'uc-stand:tampered';

  var atLoad = {
    gcmStatus: readJson('ucGcmStatus'),
    hasUcString: (function () {
      try {
        return !!localStorage.getItem('ucString');
      } catch (e) {
        return false;
      }
    })(),
    gpc: navigator.globalPrivacyControl === true,
    // Set by the "break a guard" buttons just before they reload. Consumed once,
    // because the SDK repairs the snapshot during the very load that follows.
    tampered: (function () {
      try {
        var v = sessionStorage.getItem(TAMPER_FLAG);
        sessionStorage.removeItem(TAMPER_FLAG);
        return v;
      } catch (e) {
        return null;
      }
    })(),
  };

  /* --------------------------------------------------------------- timeline */

  var timeline = []; // { t, kind, label, detail, phase }
  var listeners = [];

  // Everything up to UC_UI_INITIALIZED (plus a grace period) is the SDK's own
  // init. Pushes after that come from user actions — accepting in the banner
  // legitimately emits another consent_status, and counting those as duplicates
  // would flag the de-dup requirement as broken when it is not.
  var phase = 'init';

  function now() {
    return Math.round(performance.now());
  }
  function record(kind, label, detail) {
    timeline.push({ t: now(), kind: kind, label: label, detail: detail, phase: phase });
    listeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {}
    });
  }

  /* --- dataLayer interception ------------------------------------------------
   * A plain wrapper installed before gtm.js runs. When GTM takes over it reads
   * the existing `push` and keeps calling it as the "original", so every later
   * push still flows through here.
   *
   * Do NOT install this as an accessor whose getter always returns the hook:
   * GTM captures `dataLayer.push` as its original and calls it from its own
   * replacement, so a getter that hands back the hook makes the two call each
   * other forever ("Maximum call stack size exceeded", and the page dies).
   *
   * The poller below is the safety net for the opposite case — a consumer that
   * appends without going through `push` at all.                            */

  window.dataLayer = window.dataLayer || [];
  var seen = window.dataLayer.length;

  // Records one dataLayer entry. `suffix` marks entries the poller found rather
  // than saw pushed, whose timestamp is approximate.
  function classify(arg, suffix) {
    var name;
    // gtag(...) forwards its own `arguments` object: array-like, first slot a
    // command string. Checked before the plain-object branch, which would
    // otherwise read a numeric key off it.
    var isGtagCall =
      arg && typeof arg === 'object' && typeof arg.length === 'number' && typeof arg[0] === 'string';
    if (isGtagCall) {
      name = 'gtag ' + arg[0] + (typeof arg[1] === 'string' ? ' ' + arg[1] : '');
    } else if (arg && typeof arg === 'object') {
      name = arg.event || Object.keys(arg)[0] || '(object)';
    } else {
      name = String(arg);
    }

    var kind = 'other';
    if (/^gtag (consent|set)/.test(name)) kind = 'consent-mode';
    else if (name === 'consent_status') kind = 'consent-status';
    else if (/^gtm\./.test(name)) kind = 'gtm';
    else if (PAGE.ecom && PAGE.ecom.some(function (e) { return e.event === name; })) kind = 'ecom';

    record(kind, name + (suffix || ''), arg);

    if (kind === 'consent-status') onConsentStatus(arg);
    if (kind === 'ecom') onEcomEvent(name);
  }

  function hookedPush() {
    for (var i = 0; i < arguments.length; i++) classify(arguments[i]);
    var result = Array.prototype.push.apply(window.dataLayer, arguments);
    seen = window.dataLayer.length;
    return result;
  }

  window.dataLayer.push = hookedPush;

  // Safety net: pick up anything that reached the array without calling push.
  function drainUnseen() {
    while (window.dataLayer.length > seen) {
      var entry = window.dataLayer[seen];
      seen++;
      classify(entry, ' (observed)');
    }
  }

  /* --- CMP network timings ---------------------------------------------------
   * fetchCmpData resolves at the responseEnd of the `…/cmp/<lang>/…` request;
   * fetchSettingsCoreData is the earlier `…/core/<settingsId>` request.
   * Comparing the consent_status push against the cmp responseEnd is the whole
   * point of the fix: the early emit must land BEFORE it.                    */

  var net = { core: null, cmpData: null, pixelScript: null, pixelBeacon: null, gtmJs: null };

  function noteResource(entry) {
    var url = entry.name;
    var end = Math.round(entry.responseEnd || entry.startTime);

    if (/api\.service\.cmp\./.test(url) && /\/core\//.test(url) && net.core === null) {
      net.core = end;
      record('net', 'settings core response', url);
    } else if (/api\.service\.cmp\./.test(url) && /\/cmp\//.test(url) && net.cmpData === null) {
      net.cmpData = end;
      record('net', 'fetchCmpData response', url);
    } else if (/googletagmanager\.com\/gtm\.js/.test(url) && net.gtmJs === null) {
      net.gtmJs = end;
    } else if (/connect\.facebook\.net/.test(url) && net.pixelScript === null) {
      net.pixelScript = end;
      record('pixel', 'FB Pixel library loaded', url);
    } else if (/facebook\.com\/tr/.test(url) && net.pixelBeacon === null) {
      net.pixelBeacon = end;
      record('pixel', 'FB Pixel event sent', url);
    }
  }

  try {
    var observer = new PerformanceObserver(function (list) {
      list.getEntries().forEach(noteResource);
    });
    observer.observe({ type: 'resource', buffered: true });
  } catch (e) {}

  /* --- simulated consent-gated tag ------------------------------------------
   * Mirrors what a GTM Custom HTML tag with a consent_status trigger does, so
   * the AC8 effect is visible even before the GTM container is configured:
   * an eCom event that happens while consent is still unknown is lost, and the
   * tag only fires once consent_status arrives.                             */

  var gated = { firedAt: null, missedEcom: [], consentValue: null };

  function marketingConsentFrom(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (cfg.service && typeof payload[cfg.service] === 'boolean') return payload[cfg.service];
    var cat = payload.ucCategory || {};
    if (typeof cat.marketing === 'boolean') return cat.marketing;
    return null;
  }

  function onConsentStatus(payload) {
    var value = marketingConsentFrom(payload);
    if (gated.consentValue === null) gated.consentValue = value;
    if (value === true && gated.firedAt === null) {
      gated.firedAt = now();
      record('gated', 'simulated consent-gated tag FIRED', payload);
    }
  }

  function onEcomEvent(name) {
    if (gated.firedAt === null) gated.missedEcom.push({ name: name, t: now() });
  }

  /* ------------------------------------------------------------- page setup */

  // 1. Consent Mode v2 defaults — must precede the GTM snippet.
  //    Shape per Usercentrics SKB "Implementing Google Consent Mode" (option 2)
  //    and Google's own Consent Mode docs.
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = window.gtag || gtag;
  gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    wait_for_update: 2000,
  });
  gtag('set', 'ads_data_redaction', true);

  // 2. The GTM container is pasted into the page HTML, not injected here.
  //    Its ID is read back off the script tag the snippet inserts, for display.
  function detectGtmContainer() {
    var scripts = document.querySelectorAll('script[src*="googletagmanager.com/gtm.js"]');
    for (var i = 0; i < scripts.length; i++) {
      var m = /[?&]id=([^&]+)/.exec(scripts[i].src);
      if (m) return decodeURIComponent(m[1]);
    }
    return '';
  }

  // 3. Usercentrics CMP. Injected dynamically so the loader URL / settingsId /
  //    sandbox flag can be swapped from the panel without editing the HTML.
  //    NOTE: data-sandbox is parsed as !!string in cmp.ts — "false" would also
  //    be truthy, so the attribute is omitted entirely when sandbox is off.
  function injectCmp() {
    if (document.getElementById('usercentrics-cmp')) return;
    if (!cfg.settingsId) {
      record('warn', 'settingsId not configured', 'pass ?settingsId=…');
      return;
    }
    var s = document.createElement('script');
    s.id = 'usercentrics-cmp';
    s.src = cfg.loader;
    s.async = true;
    s.setAttribute('data-settings-id', cfg.settingsId);
    if (cfg.sandbox) s.setAttribute('data-sandbox', '1');
    document.head.appendChild(s);
    record('cmp', 'CMP loader injected', cfg.loader);
  }

  // 4. eCommerce events, pushed synchronously right after the snippets — this
  //    is the reported scenario: they beat consent_status on every page load.
  function pushEcom() {
    (PAGE.ecom || []).forEach(function (evt) {
      window.dataLayer.push(evt);
    });
  }

  // Phase 2, called by the page once the GTM snippet has run.
  var started = false;
  function start() {
    if (started) return;
    started = true;
    injectCmp();
    pushEcom();
  }

  /* --------------------------------------------------------------- CMP events */

  var bannerShown = false;

  window.addEventListener('UC_UI_INITIALIZED', function () {
    record('cmp', 'UC_UI_INITIALIZED', null);
    setTimeout(function () {
      phase = 'post';
    }, 500);
  });
  window.addEventListener('UC_UI_CMP_EVENT', function (e) {
    var type = e.detail && e.detail.type;
    if (type === 'CMP_SHOWN') bannerShown = true;
    record('cmp', 'UC_UI_CMP_EVENT ' + type, e.detail);
  });

  /* ----------------------------------------------------------------- verdict */

  function consentStatusEntries(includePost) {
    return timeline.filter(function (e) {
      return e.kind === 'consent-status' && (includePost || e.phase === 'init');
    });
  }

  // What the code under test should do on THIS page load, given the state that
  // was in localStorage before the CMP started. Mirrors the guards in
  // WebSdk.ts:299-321 — everything the page can observe without the SDK.
  function expectation() {
    var snap = atLoad.gcmStatus;
    var cs = snap && snap.consentStatus;

    if (!cs) {
      if (atLoad.hasUcString) {
        return {
          code: 'AC5',
          early: false,
          why: 'consent exists (ucString) but no ucGcmStatus snapshot — pre-feature visitor. ' +
            'No early emit this visit; the snapshot should be backfilled for the next one.',
        };
      }
      return {
        code: 'AC1',
        early: false,
        why: 'first visit, nothing cached — no early emit, one late consent_status.',
      };
    }
    if (!snap.dataLayerNames || !snap.dataLayerNames.length) {
      return { code: 'AC3', early: false, why: 'snapshot has no dataLayerNames — nothing to push into.' };
    }
    if (cs.settingsId !== cfg.settingsId) {
      return {
        code: 'AC3',
        early: false,
        why: 'snapshot was recorded for settingsId "' + cs.settingsId + '", page is running "' + cfg.settingsId + '".',
      };
    }
    if (atLoad.gpc) {
      return { code: 'AC3', early: false, why: 'Global Privacy Control is active — GPC is only honoured after cmpData.' };
    }
    if (atLoad.tampered) {
      return {
        code: 'AC3',
        early: false,
        why: 'the snapshot was deliberately broken before this load (' + atLoad.tampered +
          ') — the guard must skip the early emit.',
      };
    }
    // The resurface guards depend on the consent timestamp, which lives inside
    // the compressed ucString and is not readable here. So AC2 is the
    // expectation, and a resurface (observable: the banner reopens) is accepted
    // as the correct alternative outcome rather than scored as a failure.
    var caveat = '';
    if (cs.reshowAfterDays) caveat += ' Snapshot carries reshowAfterDays=' + cs.reshowAfterDays + '.';
    if (cs.renewConsentsTimestamp) caveat += ' Snapshot carries renewConsentsTimestamp.';
    if (caveat) caveat += ' If a resurface is due, no early emit is the correct outcome (AC3).';

    return {
      code: 'AC2',
      early: true,
      resurfacePossible: !!caveat,
      why:
        'returning visitor, snapshot matches this settingsId, no GPC — expect ONE early consent_status, ' +
        'pushed before the fetchCmpData response.' + caveat,
    };
  }

  function verdict() {
    var exp = expectation();
    var events = consentStatusEntries();
    var postEvents = consentStatusEntries(true).length - events.length;
    var lines = [];
    var status = 'info';

    lines.push('Expected on this load: ' + exp.code + ' — ' + exp.why);
    lines.push('');
    lines.push('consent_status pushes during init: ' + events.length);

    if (!events.length) {
      lines.push('  (none yet — still initializing, or the CMP did not emit at all)');
      return { status: 'info', text: lines.join('\n') };
    }

    var first = events[0].t;
    lines.push('  first push at t=' + first + 'ms');
    events.slice(1).forEach(function (e, i) {
      lines.push('  extra push #' + (i + 2) + ' at t=' + e.t + 'ms');
    });
    if (postEvents) {
      lines.push('plus ' + postEvents + ' after a user action (expected — not counted against the de-dup rule)');
    }
    lines.push('fetchCmpData response at: ' + (net.cmpData === null ? 'not observed yet' : 't=' + net.cmpData + 'ms'));

    var wasEarly = net.cmpData !== null && first < net.cmpData;
    if (net.cmpData !== null) {
      lines.push(
        'Verdict on timing: consent_status was ' +
          (wasEarly ? 'EARLY — ' + (net.cmpData - first) + 'ms before' : 'LATE — ' + (first - net.cmpData) + 'ms after') +
          ' the cmpData response.',
      );
    }
    lines.push('');

    // Exactly one consent_status during init is the de-dup requirement (AC2).
    if (events.length > 1) {
      status = 'fail';
      lines.push('FAIL — ' + events.length + ' consent_status events during init. Exactly one is required;');
      lines.push('       the early emit must suppress the later authoritative push.');
    } else if (exp.early === true) {
      if (wasEarly) {
        status = 'pass';
        lines.push('PASS — one consent_status, pushed before fetchCmpData resolved.');
      } else if (net.cmpData === null) {
        status = 'info';
        lines.push('… waiting for the cmpData request to be observed.');
      } else if (exp.resurfacePossible && bannerShown) {
        status = 'pass';
        lines.push('PASS — no early emit, and the banner reopened: a resurface was due, so skipping the');
        lines.push('       early emit is the correct behaviour (AC3). Re-accept to test AC2 on the next load.');
      } else {
        status = 'fail';
        lines.push('FAIL — a returning visitor got only the late push, and no resurface happened.');
        lines.push('       The early emit did not fire when it should have.');
      }
    } else if (exp.early === false) {
      if (wasEarly) {
        status = 'fail';
        lines.push('FAIL — consent_status was emitted early although a guard should have blocked it.');
        lines.push('       This is the false-positive case AC3 protects against.');
      } else {
        status = 'pass';
        lines.push('PASS — single late consent_status, no early emit (as expected for ' + exp.code + ').');
      }
    }

    // AC4 / AC5: the snapshot must be rewritten to match the applied consent on
    // every load, so a mismatch heals itself and a missing one is backfilled.
    var liveSnap = readJson('ucGcmStatus');
    var before = atLoad.gcmStatus && atLoad.gcmStatus.consentStatus;
    var after = liveSnap && liveSnap.consentStatus;
    if (after && (!before || before.consentHash !== after.consentHash)) {
      lines.push('');
      lines.push(
        !before
          ? 'Snapshot was backfilled this load (AC5) — the next visit is eligible for the early emit.'
          : 'Snapshot self-healed this load (AC4): consentHash ' +
            String(before.consentHash).slice(0, 12) + '… -> ' + String(after.consentHash).slice(0, 12) + '…',
      );
    }

    // AC8: the consent-gated tag and the eCom events it should have seen.
    lines.push('');
    lines.push('--- consent-gated tag (simulated) ---');
    lines.push(
      'marketing consent in payload: ' +
        (gated.consentValue === null
          ? 'not found — check the ?service= name against the Admin Interface'
          : String(gated.consentValue)),
    );
    if (gated.firedAt !== null) {
      lines.push('tag fired at t=' + gated.firedAt + 'ms');
      if (gated.missedEcom.length) {
        lines.push(
          'eCom events that happened BEFORE it: ' +
            gated.missedEcom
              .map(function (m) {
                return m.name + ' (t=' + m.t + ')';
              })
              .join(', '),
        );
        lines.push('  -> in a real container those are the events a consent-gated tag misses.');
      } else {
        lines.push('no eCom event preceded it on this load.');
      }
    } else {
      lines.push('tag did not fire (no marketing consent, or consent_status not seen yet).');
    }

    return { status: status, text: lines.join('\n') };
  }

  /* ------------------------------------------------------------------- panel */

  var KIND_LABEL = {
    'consent-mode': 'consent mode',
    'consent-status': 'consent_status',
    ecom: 'eCommerce',
    gtm: 'GTM',
    cmp: 'CMP',
    net: 'network',
    pixel: 'pixel',
    gated: 'gated tag',
    warn: 'warning',
    other: '',
  };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderTimeline(host) {
    host.innerHTML = '';
    var table = el('table', 'tl');
    timeline.forEach(function (e) {
      var tr = el('tr', 'k-' + e.kind);
      tr.appendChild(el('td', 't', e.t + 'ms'));
      tr.appendChild(el('td', 'kind', KIND_LABEL[e.kind] || ''));
      tr.appendChild(el('td', 'label', e.label));
      table.appendChild(tr);
    });
    host.appendChild(table);
  }

  function renderSnapshot(host) {
    host.innerHTML = '';
    var live = readJson('ucGcmStatus');

    host.appendChild(el('div', 'sub', 'At page load (before the CMP ran):'));
    host.appendChild(
      el('pre', '', atLoad.gcmStatus ? JSON.stringify(atLoad.gcmStatus, null, 2) : '(no ucGcmStatus key)'),
    );
    host.appendChild(el('div', 'sub', 'Now (after the CMP wrote to it):'));
    host.appendChild(el('pre', '', live ? JSON.stringify(live, null, 2) : '(no ucGcmStatus key)'));
    host.appendChild(
      el(
        'div',
        'hint',
        'The key must exist only when Google Consent Mode is ON and at least one Data Layer is configured ' +
          '(isGcmStatusTrackingEnabled). ucString present: ' + (atLoad.hasUcString ? 'yes' : 'no') + '.',
      ),
    );
  }

  /* --- tamper helpers -------------------------------------------------------
   * Same manipulations the unit tests do (consentStatusEarlyEmit.test.ts), but
   * against real localStorage, so each AC3 guard can be exercised by hand.   */

  function tamper(mutate, note, label) {
    var snap = readJson('ucGcmStatus');
    if (!snap || !snap.consentStatus) {
      alert('No ucGcmStatus snapshot yet. Accept consent once, then reload.');
      return;
    }
    mutate(snap.consentStatus);
    try {
      localStorage.setItem('ucGcmStatus', JSON.stringify(snap));
      sessionStorage.setItem(TAMPER_FLAG, label);
    } catch (e) {}
    if (confirm(note + '\n\nReload now to see the guard take effect?')) location.reload();
  }

  var TAMPERS = [
    [
      'Break consentHash',
      function () {
        tamper(
          function (cs) {
            cs.consentHash = 'hash-of-a-consent-that-was-since-replaced';
          },
          'consentHash broken — simulates consent restored via CDCS / cross-device / v2 migration.\nExpected: no early emit, and the snapshot self-heals (AC3 + AC4).',
          'consentHash',
        );
      },
    ],
    [
      'Break settingsVersion',
      function () {
        tamper(
          function (cs) {
            cs.settingsVersion = 'some-other-outdated-version';
          },
          'settingsVersion set to an outdated value.\nExpected: freshness guard blocks the early emit (AC3).',
          'settingsVersion',
        );
      },
    ],
    [
      'Force reshowAfterDays',
      function () {
        tamper(
          function (cs) {
            cs.reshowAfterDays = 0.0001;
          },
          'reshowAfterDays set to ~0 — consent is now "older than" its validity.\nExpected: no early emit, banner resurfaces (AC3).',
          'reshowAfterDays',
        );
      },
    ],
    [
      'Force renewConsentsTimestamp',
      function () {
        tamper(
          function (cs) {
            cs.renewConsentsTimestamp = Math.floor(Date.now() / 1000);
          },
          'renewConsentsTimestamp set to now — an admin-triggered renewal is due.\nExpected: no early emit (AC3).',
          'renewConsentsTimestamp',
        );
      },
    ],
  ];

  function clearUcKeys() {
    UC_KEYS.forEach(function (k) {
      try {
        localStorage.removeItem(k);
      } catch (e) {}
    });
    // v1/v2 keys the CMP may also have written
    try {
      Object.keys(localStorage).forEach(function (k) {
        if (/^uc[_A-Z]/.test(k) || k.indexOf('usercentrics') === 0) localStorage.removeItem(k);
      });
    } catch (e) {}
    location.reload();
  }

  function report() {
    var v = verdict();
    var lines = [];
    lines.push('EUD-4042 test stand report');
    lines.push('page:       ' + PAGE.name + '  (' + location.href + ')');
    lines.push('loader:     ' + cfg.loader);
    lines.push('settingsId: ' + cfg.settingsId + '   data-sandbox: ' + (cfg.sandbox ? '1' : '(off)'));
    lines.push('GTM:        ' + (detectGtmContainer() || '(no container on page)') + '   pixel: ' + cfg.pixel);
    lines.push('service:    ' + (cfg.service || '(falling back to marketing category)'));
    lines.push('GPC:        ' + (atLoad.gpc ? 'ACTIVE' : 'off'));
    lines.push('');
    lines.push(v.text);
    lines.push('');
    lines.push('--- dataLayer timeline ---');
    timeline.forEach(function (e) {
      lines.push(String(e.t).padStart(6) + 'ms  ' + (KIND_LABEL[e.kind] || '-') + '  ' + e.label);
    });
    lines.push('');
    lines.push('--- ucGcmStatus at page load ---');
    lines.push(atLoad.gcmStatus ? JSON.stringify(atLoad.gcmStatus, null, 2) : '(none)');
    lines.push('--- ucGcmStatus now ---');
    var live = readJson('ucGcmStatus');
    lines.push(live ? JSON.stringify(live, null, 2) : '(none)');
    return lines.join('\n');
  }

  function buildPanel() {
    var host = document.getElementById('uc-panel');
    if (!host) return;

    host.innerHTML =
      '<header>' +
      '<strong>EUD-4042 stand</strong>' +
      '<span id="uc-page-name"></span>' +
      '<button id="uc-collapse" title="collapse">–</button>' +
      '</header>' +
      '<div class="body">' +
      '<div class="cfg" id="uc-cfg"></div>' +
      '<div class="verdict" id="uc-verdict"></div>' +
      '<div class="acts" id="uc-acts"></div>' +
      '<h4>dataLayer timeline</h4>' +
      '<div id="uc-timeline"></div>' +
      '<h4>ucGcmStatus</h4>' +
      '<div id="uc-snapshot"></div>' +
      '<h4>break a guard (AC3)</h4>' +
      '<div class="acts" id="uc-tampers"></div>' +
      '</div>';

    host.querySelector('#uc-page-name').textContent = PAGE.name;
    host.querySelector('#uc-collapse').addEventListener('click', function () {
      host.classList.toggle('collapsed');
      this.textContent = host.classList.contains('collapsed') ? '+' : '–';
    });

    var cfgHost = host.querySelector('#uc-cfg');
    function cfgRow(k, v, warn) {
      var row = el('div', warn ? 'row warn' : 'row');
      row.appendChild(el('span', 'k', k));
      row.appendChild(el('span', 'v', v));
      cfgHost.appendChild(row);
    }
    var container = detectGtmContainer();
    cfgRow('settingsId', cfg.settingsId || 'NOT SET — pass ?settingsId=…', !cfg.settingsId);
    cfgRow('loader', cfg.loader.replace('https://', ''));
    cfgRow('data-sandbox', cfg.sandbox ? '1' : 'off');
    cfgRow('GTM', container || 'no container snippet on this page', !container);
    cfgRow('pixel ID', cfg.pixel);
    cfgRow('service (DPS)', cfg.service || 'marketing category (fallback)', !cfg.service);
    cfgRow('GPC', atLoad.gpc ? 'ACTIVE' + (cfg.gpc === '1' ? ' (shimmed by ?gpc=1)' : ' (browser)') : 'off');

    var acts = host.querySelector('#uc-acts');
    [
      ['Reload', function () { location.reload(); }],
      ['Reset consent (uc* keys)', clearUcKeys],
      [
        'clearUserSession()',
        function () {
          if (!window.__ucCmp) return alert('__ucCmp not available yet.');
          window.__ucCmp.clearUserSession().then(function () {
            alert('clearUserSession() done. ucGcmStatus must be gone (AC7).\n\nucGcmStatus now: ' +
              (localStorage.getItem('ucGcmStatus') || '(removed)'));
          });
        },
      ],
      [
        'Open consent layer',
        function () {
          if (!window.__ucCmp) return alert('__ucCmp not available yet.');
          window.__ucCmp.showSecondLayer();
        },
      ],
      [
        'Copy report',
        function () {
          var text = report();
          if (navigator.clipboard) {
            navigator.clipboard.writeText(text).then(
              function () { alert('Report copied to clipboard.'); },
              function () { console.log(text); alert('Clipboard blocked — report logged to console.'); },
            );
          } else {
            console.log(text);
            alert('Report logged to console.');
          }
        },
      ],
    ].forEach(function (b) {
      var btn = el('button', '', b[0]);
      btn.addEventListener('click', b[1]);
      acts.appendChild(btn);
    });

    var tampers = host.querySelector('#uc-tampers');
    TAMPERS.forEach(function (t) {
      var btn = el('button', 'danger', t[0]);
      btn.addEventListener('click', t[1]);
      tampers.appendChild(btn);
    });

    var verdictHost = host.querySelector('#uc-verdict');
    var timelineHost = host.querySelector('#uc-timeline');
    var snapshotHost = host.querySelector('#uc-snapshot');

    function refresh() {
      drainUnseen();
      var v = verdict();
      verdictHost.textContent = v.text;
      verdictHost.className = 'verdict ' + v.status;
      renderTimeline(timelineHost);
      renderSnapshot(snapshotHost);
    }

    listeners.push(refresh);
    refresh();
    // Network timings and the late push can land after the last dataLayer
    // event, so keep refreshing briefly after load.
    var ticks = 0;
    var iv = setInterval(function () {
      refresh();
      if (++ticks > 30) clearInterval(iv);
    }, 500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }

  /* Expose for console use / automation. */
  window.ucStand = {
    start: start,
    cfg: cfg,
    atLoad: atLoad,
    timeline: timeline,
    net: net,
    verdict: function () {
      drainUnseen();
      return verdict();
    },
    report: report,
    drain: drainUnseen,
    consentStatusCount: function () {
      drainUnseen();
      return consentStatusEntries().length;
    },
  };
})();
