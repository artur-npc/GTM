# EUD-4042 / CTS-2487 — `consent_status` early emit test stand

A throwaway shop page that reproduces the customer setup behind
[CTS-2487](https://usercentrics.atlassian.net/browse/CTS-2487) and lets every acceptance criterion of
[EUD-4042](https://usercentrics.atlassian.net/browse/EUD-4042) be checked by hand.

**Live:** https://artur-npc.github.io/GTM/

## What bug this is about

`consent_status` used to be pushed to the dataLayer only at the very end of the SDK's init chain,
after the `fetchCmpData` network round-trip (~200–600 ms). eCommerce events that a shop pushes on
page render therefore arrived *first*, and any tag gated on marketing consent — Facebook Pixel being
the reported case — never fired for those events, even for a returning visitor who had already
accepted marketing cookies and merely reloaded the page.

The fix emits `consent_status` from a cached `ucGcmStatus` localStorage snapshot *before*
`fetchCmpData`, and suppresses the later authoritative push so there is still exactly one event per
page load.

## Pages

| Page | Pushes on load | Use for |
|---|---|---|
| `index.html` | `view_item`, `add_to_cart` | main scenario, reloads |
| `checkout.html` | `begin_checkout`, `purchase` | returning visitor via navigation; conversion tag |

## Script order on the page

Container `GTM-NSGZ3XN5` is installed the standard way — the snippet pasted as
high in the `<head>` as possible, the `<noscript>` iframe at the top of `<body>`. The
instrumentation sits around it in two phases, and the order must not be changed:

```html
<script>window.UC_STAND_PAGE = { name: …, ecom: [ … ] };</script>
<script src="uc-gtm-kit.js"></script>   <!-- dataLayer recorder, then Consent Mode defaults -->

<!-- Google Tag Manager -->  …verbatim snippet…  <!-- End Google Tag Manager -->

<script>window.ucStand.start();</script> <!-- CMP loader, then the eCommerce events -->
```

Phase 1 must run first for two reasons: the recorder has to own `dataLayer.push`
before anything pushes, and Consent Mode defaults have to be registered before the
container loads. Everything else — the CMP and the shop's events — happens after the
container, exactly as on a customer page.

To point the stand at a different container, edit the snippet in both HTML files.

## Configuration

Everything is a query parameter. Parameters are persisted to `localStorage`, so they only need to be
passed once per browser:

```
https://artur-npc.github.io/GTM/?settingsId=XXXX&gtm=GTM-XXXXXX&service=Facebook%20Pixel
```

| Param | Default | Meaning |
|---|---|---|
| `settingsId` | *(none — must be set)* | CMP configuration to load |
| `loader` | PR 1628 build | `pr`, `prod`, or a full loader URL |
| `sandbox` | `1` | adds `data-sandbox="1"` |
| `service` | *(none)* | DPS name **exactly** as spelled in the Admin Interface, for the simulated gated tag. Omitted → falls back to the `marketing` category |
| `pixel` | `000000000000000` | Pixel ID shown in the panel, for pasting into GTM |
| `gpc` | off | `1` shims `navigator.globalPrivacyControl` for this load only (not persisted) |

The default loader is
`https://web.cmp.usercentrics-sandbox.eu/ui/pr/1628/loader.js` — the PR build carrying the fix. Its
bundle has the sandbox API domain baked in at build time, but **consent saving, cross-device
retrieval and the tag logger still follow the `data-sandbox` flag**, and the `ucGcmStatus` snapshot is
written when consent is saved — so leave `sandbox=1` on unless you know you want otherwise.

> `data-sandbox` is parsed as `!!string` in `cmp.ts`, so `data-sandbox="false"` would also be truthy.
> The kit omits the attribute entirely when `sandbox=0`.

## Domain allow list

The CMP refuses to initialize on a host that is not on the configuration's allow list — the console
shows *“The domain … has not been added to the allow list for this Usercentrics account.”* and nothing
renders.

`artur-npc.github.io` is already allow-listed on the shared sandbox configurations
(`HTrWecvQcUoC94`, `GQIS-mIN1kW_ah`, `cqNAsnaCNNTg5s`). For your own settingsId, add it under
Admin Interface → Configuration → Domains. `localhost` is **not** allow-listed, which is why this
stand is hosted rather than run locally.

## CMP configuration prerequisites

The snapshot key is only ever created when **both** hold (`isGcmStatusTrackingEnabled()`):

1. **Google Consent Mode is ON** — Admin Interface → Configuration → CMP Settings → Google Consent Mode.
2. **At least one Data Layer is configured** — Admin Interface → Configuration → Data exchange on page → Data Layer.

For the gating negatives you need two more configurations: one with GCM off, one with GCM on but no
Data Layer.

## GTM container setup (once, by hand)

The container snippet is already on the pages; what follows is the tag/trigger/variable setup
**inside** container `GTM-NSGZ3XN5`, done the way the official Usercentrics documentation
prescribes for consent-aware non-Google tags (Data Layer Variable + `consent_status` trigger).

### 1. Variable — `Facebook Pixel Variable`

Variables → User-Defined Variables → New → **Data Layer Variable**

- Data Layer Variable Name: `Facebook Pixel` — the DPS name, exact spelling, capitalization and
  hyphenation. Use the same string in `?service=`.
- Check **Set Default Value**, value `false`.

### 2. Trigger — `Facebook Pixel Trigger`

Triggers → New → **Custom Event**

- Check **Use regex matching**.
- Event name: `consent_status.*`
- **Some Custom Events**, condition: `Facebook Pixel Variable` **contains** `true`.

### 3. Tag A — `Facebook Pixel — base`

Tags → New → **Custom HTML**, trigger = `Facebook Pixel Trigger`, firing option **Once per page**.

```html
<script>
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window,document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '000000000000000');
fbq('track', 'PageView');
</script>
```

The ID is deliberately fake. What is being verified is that the tag *fires on this page load* — visible
in GTM Preview and as a request to `connect.facebook.net` — not that Meta accepted anything.

### 4. Tag B — `Facebook Pixel — ViewContent` (optional but recommended)

Custom HTML with `fbq('track', 'ViewContent');`, trigger = Custom Event `view_item`, and under
**Advanced Settings → Consent Settings** set *Require additional consent for tag to fire*: `ad_storage`.

This is the sharp end of the bug: `view_item` fires before consent is known, so GTM holds the tag
until `ad_storage` is granted. Before the fix it was granted too late to matter; after the fix it
arrives in time.

### 5. Optional — a Google tag

A Google Tag (GA4) with its Measurement ID needs no consent trigger — Google tags have built-in
consent checks and respond to Consent Mode directly. Useful as a control: it fires either way, while
Tag A does not.

Publish the container, or use **Preview** and enter the stand URL.

## The panel

Fixed on the right of every page:

- **Config** — what the page actually loaded; missing required values are highlighted.
- **Verdict** — what the SDK *should* do on this load (derived from the snapshot state read **before**
  the CMP ran), how many `consent_status` events actually happened, and whether the first one landed
  before or after the `fetchCmpData` response. Green = as expected, red = not.
- **dataLayer timeline** — every push with a `performance.now()` timestamp, plus observed network
  milestones. `consent_status` is highlighted; eCommerce events are amber.
- **ucGcmStatus** — the snapshot as it was at page load and as it is now.
- **Break a guard** — the same tampering the unit tests do, applied to real localStorage.

`window.ucStand` exposes `verdict()`, `report()`, `timeline`, `net` and `consentStatusCount()` for
console use. **Copy report** puts a full text report on the clipboard for pasting into Jira.

## Test matrix

Reset between independent cases with **Reset consent (uc\* keys)**.

| AC | Setup | Steps | Expected |
|---|---|---|---|
| **AC1** | fresh browser / after reset | load `index.html` | panel expects AC1; exactly **one** `consent_status`, **after** the cmpData response. Banner shows |
| — | — | accept all | `ucGcmStatus` appears with both `consentStatus` and `dataLayerNames` |
| **AC2** | after AC1 | reload | exactly **one** `consent_status`, **before** the cmpData response. Verdict green |
| **AC8** | GTM container published, Tag A + B configured | reload as returning visitor, GTM Preview open | Tag A fires on this load; Tag B (held on `ad_storage`) fires too. Simulated gated tag in the panel fires and lists the eCom events that preceded it |
| **AC8** | same | navigate to `checkout.html` | `purchase` is pushed and the conversion tag fires on that same load |
| **AC3** hash | returning visitor | **Break consentHash** → reload | no early emit; single late `consent_status`. Verdict green for AC3 |
| **AC4** | right after the above | inspect `ucGcmStatus` "now" | hash has been rewritten to match the applied consent — self-healed |
| **AC3** version | returning visitor | **Break settingsVersion** → reload | no early emit |
| **AC3** reshow | returning visitor | **Force reshowAfterDays** → reload | no early emit; banner resurfaces |
| **AC3** renew | returning visitor | **Force renewConsentsTimestamp** → reload | no early emit |
| **AC3** GPC | returning visitor | append `&gpc=1` and load | panel shows GPC ACTIVE; no early emit |
| **AC5** | consent given, then delete only `ucGcmStatus` in DevTools | reload | no early emit this load, but the snapshot is backfilled; reload again → early emit works |
| **AC6** | any configured setup | first load ever, before any consent | `ucGcmStatus.dataLayerNames` is populated even though `consentStatus` is not |
| **AC7** | returning visitor | **clearUserSession()** | `ucGcmStatus` is removed together with the other consent keys |
| **gating** | `?settingsId=` of a config with **GCM off** | accept consent, reload | `ucGcmStatus` is **never created**; `consent_status` stays late |
| **gating** | `?settingsId=` of a config with **GCM on, no Data Layer** | accept consent, reload | `ucGcmStatus` is **never created** |

### Cross-check with a production build

Swap `?loader=prod` to see the old behaviour on the same page: the late-only `consent_status`, and
Tag A not firing for the early eCom events. Remember that a prod loader talks to the production API,
so use a production-side settingsId for that comparison.

## Not covered here

- [CTS-3437](https://usercentrics.atlassian.net/browse/CTS-3437) (a GTM variable holding all consented
  services, no localStorage key) — accepted as a separate SPIKE, **not** implemented in EUD-4042.
- [CTS-1905](https://usercentrics.atlassian.net/browse/CTS-1905) — the UC GTM template tag reading GCM
  state from localStorage. The snapshot format is now a public contract, but the template itself is a
  separate ticket.
- The key `ucConsentStatus` mentioned in an early CTS-2487 comment no longer exists; everything was
  merged into `ucGcmStatus`. Likewise, the "two fires per reload" described in that comment was
  replaced by de-duplication — two events now mean a defect.
