# Anyam identity knockout screen

**Decision date:** 1 August 2026  
**Decision type:** product, CLI, package, protocol, and domain working-name screen  
**Status:** decision-grade knockout research; **not** a legal opinion, formal trademark clearance, company-name reservation, package reservation, or domain acquisition

## Executive verdict

**Conditional go:** continue using **Anyam** as the working product and `anyam` as the intended CLI command, but do not announce the brand publicly, spend materially on it, publish packages, or promise `anyam.dev` until the acquisition and legal gates in this document are complete.

The name has a strong, authentic product metaphor. Dewan Bahasa dan Pustaka defines Malay *anyam* as arranging or joining material in an interlaced pattern, and gives the pronunciation as `[a.nyam]`. That maps naturally to Anyam's job of composing source spaces, changes, evidence, and releases. [[DBP PRPM](https://prpm.dbp.gov.my/Cari1?d=243192&keyword=anyam)]

No exact-name source-control or developer-platform product was found in the primary sources reviewed. That is **not** a proof of worldwide absence. More importantly, a perfectly unified namespace is already impossible without acquiring rights from third parties:

- GitHub's exact `anyam` account exists and is a user account created in 2021. [[GitHub API](https://api.github.com/users/anyam)]
- GitHub's adjacent unhyphenated `AnyamDev` identity is also occupied by an organization created in 2026. [[GitHub API](https://api.github.com/users/AnyamDev)]
- npm's exact `@anyam` scope is active and contains three packages published in 2024. [[npm registry search](https://registry.npmjs.org/-/v1/search?text=%40anyam&size=100)]
- Docker Hub's exact `anyam` user/namespace exists, although it currently exposes no public repositories. [[Docker Hub API](https://hub.docker.com/v2/users/anyam/)]
- `anyam.com`, `anyam.app`, and `anyam.ai` are registered. [[Verisign RDAP](https://rdap.verisign.com/com/v1/domain/anyam.com)] [[Google Registry RDAP](https://pubapi.registry.google/rdap/domain/anyam.app)] [[Identity Digital RDAP](https://rdap.identitydigital.services/rdap/domain/anyam.ai)]
- The authoritative `.dev` registry returned `404 Not Found` for `anyam.dev` at the time of this screen. That means the registry had no current registration object; it does **not** guarantee a normal-price, non-reserved, immediately purchasable registration. [[Google Registry RDAP](https://pubapi.registry.google/rdap/domain/anyam.dev)]
- **Du Anyam** is an established Indonesian social enterprise whose identity and public story center on weaving, women weavers, and cultural preservation. Its 2025 impact report describes multi-generational weaving and a community livelihood mission. This is not an SCM collision, but it is a meaningful regional brand and narrative adjacency. [[Du Anyam 2025 impact report](https://duanyam.com/wp-content/uploads/2026/02/Du-Anyam-Impact-Report-2025-1.pdf)]

Therefore, the viable identity is:

> **Anyam is the human-facing brand and `anyam` is the command; globally unique technical identifiers use a controlled `anyam.dev`-derived namespace after the domain is acquired.**

Until then, packages, containers, and repositories stay under `wms2537` or another already controlled owner. The project must not imply ownership of `@anyam`, `github.com/anyam`, or `docker.io/anyam`.

## What this screen establishes—and what it does not

### Confirmed by primary sources

- The Malay meaning and pronunciation.
- Current public records returned by official GitHub, npm, Docker Hub, IANA, Companies House, and gTLD RDAP endpoints.
- The scope of the relevant Nice classes.
- The existence and positioning of Du Anyam.
- The official search and filing paths for Malaysia, Singapore, the United Kingdom, the United States, the EU, and WIPO.

### Not established

- Worldwide trademark registrability or freedom to use.
- Common-law/unregistered rights.
- Confusing similarity across spelling, sound, meaning, or logo.
- Company-name availability in Malaysia, Singapore, or other incorporation jurisdictions.
- Registrar checkout availability, price, or premium/reserved status of `anyam.dev`.
- Availability of an npm scope, GitHub organization, Docker namespace, package name, app-store name, or social handle at the moment someone attempts to claim it.
- Ownership or acquisition terms for any already registered domain or namespace.

WIPO explicitly says its Global Brand Database does not replace national or regional searches, results may be incomplete, exact matches are insufficient, and legal assistance may be needed. It also prohibits automated querying of the database. [[WIPO search guidance](https://www.wipo.int/en/web/madrid-system/how_to/search/index)] [[WIPO Global Brand Database FAQ](https://www.wipo.int/en/web/global-brand-database/faqs_branddb)]

## Screening matrix

| Surface | Result on 1 August 2026 | Risk | Decision |
|---|---|---:|---|
| Product word | Real Malay word with a positive, relevant meaning | Amber | Strong working brand; potentially weaker exclusivity in Malay/Indonesian markets |
| Pronunciation | DBP gives `[a.nyam]` | Green | Brand guide uses **AH-nyam** as the English approximation and preserves local pronunciation |
| Exact SCM/developer platform | No exact product found in reviewed primary sources | Amber | No discovered knockout; absence is bounded to the reviewed set |
| GitHub identity | `github.com/anyam` exists as a user | Red for exact namespace | Keep `Whyme-Labs/anyam`; pursue `anyam-dev` or a company-owned alternative only after clearance |
| npm scope | `@anyam` is occupied and publishing | Red for exact scope | Never publish under `@anyam` without a legitimate transfer; use a controlled alternate scope |
| npm unscoped package | Official package endpoint returned 404 for `anyam` | Amber | A 404 is not a reservation; do not publish before legal clearance |
| PyPI project | Official JSON endpoint returned 404 for `anyam` | Amber | Same: observation, not entitlement or reservation [[PyPI API](https://pypi.org/pypi/anyam/json)] |
| crates.io | Official search returned zero matching crates; sparse-index key returned 404 | Amber | Check again immediately before publication; prefer `anyam-sdk`/`anyam-cli` over assuming the bare name [[crates.io API](https://crates.io/api/v1/crates?page=1&per_page=10&q=anyam)] |
| Homebrew core | Exact official formula and cask endpoints returned 404; official indexes had no containing match | Amber | Ship from a controlled tap first; core inclusion is a later distribution decision [[formula API](https://formulae.brew.sh/api/formula/anyam.json)] [[cask API](https://formulae.brew.sh/api/cask/anyam.json)] |
| Docker Hub | Exact user/namespace exists; zero public repositories shown | Red for exact namespace | Use `ghcr.io/<controlled-owner>/anyam/*`; do not rely on Docker Hub exact namespace |
| `anyam.dev` | Authoritative registry RDAP returned 404 | Green-to-amber | Best primary domain if checkout confirms it; acquire before public disclosure |
| `anyam.com` | Registered | Amber | Do not depend on ownership or acquisition; assess confusion/defensive value with counsel |
| `anyam.app` | Registered | Amber | Do not use or imply control |
| `anyam.ai` | Registered | Amber | Do not use or imply control; product should not need an `.ai` identity |
| IANA URI scheme | No `anyam` entry in the current official registry snapshot | Green | Do not create a custom URI scheme in v1; use HTTPS identifiers |
| IANA media type | No `anyam` string in the current official media-type registry snapshot | Green | Use ordinary JSON and versioned HTTPS schemas first; register only if interoperability later requires it |
| UK company exact name | `ANYAM LIMITED` is active and classed as solicitors | Amber | Not a software collision, but blocks assumptions about exact UK company naming [[Companies House](https://find-and-update.company-information.service.gov.uk/company/09978297)] |
| Regional cultural adjacency | Du Anyam is an active weaving-centered Indonesian social enterprise | Amber-high | Conduct counsel and stakeholder review; avoid narrative or visual imitation |
| Formal trademark rights | Not cleared | Red launch blocker | Attorney-led similarity and common-law search is mandatory before launch or filing |

Registry `404` responses are point-in-time observations. They do not reserve a name, prove that a transaction will succeed, or establish trademark rights.

## Linguistic and cultural analysis

### Meaning

DBP's official Malay dictionary describes *menganyam* as interlacing materials to make items such as mats and baskets, and also as plaiting hair. Its word family includes *anyaman* for the woven result or the act of weaving. [[DBP PRPM](https://prpm.dbp.gov.my/Cari1?d=243192&keyword=anyam)]

This creates an unusually accurate metaphor:

- Source Spaces remain separate strands.
- Project Views compose the strands a principal may see.
- Changes weave public and private work without flattening their trust boundaries.
- Evidence and release lineage bind work into a verifiable result.

### Pronunciation and international usability

The preferred local pronunciation is represented by DBP as `[a.nyam]`. For English-language launch material, write **Anyam (AH-nyam)** once in high-context places such as the About page and launch video. Do not respell the product in interfaces or use `anyam-ai` as a pronunciation aid.

Likely international friction:

- English speakers may say “AN-yam”, “ANY-am”, or separate the `n` and `y`.
- The palatal `ny` sound is familiar in Malay and Indonesian but not obvious to every English reader.
- Search results will naturally include weaving, craft, people whose surname is Anyam, and Du Anyam. This is expected lexical coexistence, not automatically infringement.

The name is short, typeable in ASCII, case-insensitive on the command line, and does not contain a hyphen, numeral, or generic category word such as `git`, `forge`, `cloud`, or `ai`.

### Cultural adjacency: Du Anyam

Du Anyam is not merely a similarly named craft seller. Its current official materials describe an Indonesian social enterprise founded around women weavers, livelihood improvement, and heritage preservation. [[Du Anyam 2026 catalogue](https://duanyam.com/wp-content/uploads/2026/02/Catalogue-Home-Interior-2026-2_compressed.pdf)]

The overlap matters because Anyam's proposed brand story also uses weaving. The safe posture is:

1. Do not claim to have invented or own the regional concept of *anyam*.
2. Do not borrow Du Anyam's women-weaver, handicraft, East Nusa Tenggara, community-impact, or heritage imagery.
3. Do not use basket, palm-leaf, textile, or artisan photography as the core developer-product identity.
4. Build a technical visual system from source graphs, interlocking trust boundaries, and atomic state transitions.
5. Include Du Anyam in counsel's similarity/common-law review even if Nice classes differ.
6. Consider a short, respectful internal brand rationale recognizing that the word is a living Malay/Indonesian term, not an invented SaaS syllable.

This adjacency does not make Anyam unusable, but it makes “weaving” a product metaphor to handle with cultural specificity rather than a decorative origin story.

## Complete naming system

The following system is normative **after `anyam.dev` is acquired and legal clearance is approved**. Until then, substitute the current controlled owner where noted.

| Surface | Normative identity | Pre-clearance rule |
|---|---|---|
| Product | **Anyam** | Allowed internally as working name |
| Pronunciation | **AH-nyam**, local `[a.nyam]` | Document; do not alter spelling |
| CLI executable | `anyam` | Reserve only after clearance; no `forge` alias |
| Git credential helper | `git-credential-anyam` | Ship with CLI, not as an unrelated credential product |
| MCP server display name | `anyam` | Project-scoped endpoint owns authorization identity |
| MCP resource | `https://mcp.anyam.dev/projects/{org}/{project}` | Do not expose before domain control |
| Product portal | `https://app.anyam.dev` | `anyam.dev` remains canonical marketing/docs root |
| Authentication | `https://auth.anyam.dev` | Separate origin and host-only cookies |
| REST API | `https://api.anyam.dev` | Version in path/media representation, not host |
| Git HTTPS | `https://git.anyam.dev/{org}/{project}.git` | Backend remotes may differ; this is the branded gateway |
| Documentation | `https://docs.anyam.dev` | Public docs link back to canonical root |
| Status | `https://status.anyam.dev` or an independently hosted status domain | Prefer failure independence over visual uniformity |
| Config file | `anyam.yaml` | One canonical spelling; no `forge.yaml` compatibility alias |
| Repository metadata | `.anyam/` | Versioned declarative metadata only; secrets prohibited |
| User config | `$XDG_CONFIG_HOME/anyam/` | Platform-native equivalent on macOS/Windows |
| User state/cache | XDG state/data/cache paths under `anyam` | Never mix credentials into project files |
| Environment variables | `ANYAM_*` | Keep the prefix reserved to first-party contracts |
| npm CLI package | `@anyam-dev/cli` or another acquired scope | **Never** use occupied `@anyam`; unscoped `anyam` may later be a thin launcher only if legitimately obtained |
| Python SDK | `anyam-sdk` distribution, `anyam` import only if secured | Verify both distribution and import-name conflicts before publication |
| Rust crate | `anyam-sdk` / `anyam-cli` | Verify current registry state immediately before publication |
| Go modules | `anyam.dev/sdk-go` | Domain-derived module identity avoids a central bare-name namespace |
| OCI images | `ghcr.io/Whyme-Labs/anyam/...` initially; migrate to controlled company org | Never publish as `docker.io/anyam/...` without control |
| GitHub repository | `github.com/Whyme-Labs/anyam` initially | Move only to a controlled organization through GitHub's supported transfer flow |
| JSON Schema identifiers | `https://schemas.anyam.dev/{schema}/{version}` | Stable HTTPS IDs, immutable by version |
| Event types | `dev.anyam.<domain>.<event>.v1` | Activate only after domain acquisition; document ownership |
| HTTP media | `application/json` with versioned schemas | Do not invent `application/vnd.anyam+json` until a consumer requires content negotiation |
| URI scheme | none | Do not create `anyam:`; HTTPS deep links and CLI commands are sufficient |
| Agent skill | `anyam` under the portable skills layout | Instructions contain no credentials |
| Logs/telemetry service name | `anyam.<component>` | No customer source or secrets in resource attributes |

### Namespace rule

Brand identity and distribution ownership are separate:

```text
Human-facing brand:      Anyam
Command:                 anyam
Authority root:          anyam.dev
Current code owner:      github.com/wms2537
Future package scope:    a legally cleared, actually acquired scope
```

Do not contort the product name to pretend the exact third-party namespaces are ours. A verified `@anyam-dev/cli` package linked from `anyam.dev` is safer than an ambiguous package published under an unrelated exact-looking owner.

## Collision findings

### Exact technical namespace collisions

#### GitHub

The official GitHub API returns an existing `User` object for `anyam`, created on 15 September 2021. It exposes no public biography or company in the current response, but ownership alone is decisive: it cannot be assumed to become the product organization. [[GitHub API](https://api.github.com/users/anyam)]

The adjacent unhyphenated `AnyamDev` organization is also occupied. The API returned `404` for the distinct hyphenated `anyam-dev` path during this screen. A GitHub `404` is not an organization-name reservation or promise that account creation will succeed. The project must test the actual organization-creation transaction only after legal approval. [[GitHub `AnyamDev` API](https://api.github.com/users/AnyamDev)]

#### npm

The npm registry search returned these packages inside the occupied `@anyam` scope:

- `@anyam/npm-boilerplate`
- `@anyam/mani`
- `@anyam/medium-common`

The exact unscoped `anyam` package endpoint returned `404`. Neither observation conveys ownership rights. npm package-name disputes and transfers must follow npm's own policies; Anyam should not approach or pressure the existing owner before counsel determines whether acquisition is necessary and appropriate. [[npm registry search](https://registry.npmjs.org/-/v1/search?text=%40anyam&size=100)] [[exact npm lookup](https://registry.npmjs.org/anyam)] [[npm disputes policy](https://docs.npmjs.com/policies/disputes)]

#### Docker Hub and containers

Docker Hub's official API returns an existing `anyam` user. The correct first-party container path is therefore a controlled GitHub Container Registry owner such as `ghcr.io/Whyme-Labs/anyam/...`, followed later by a verified company organization. [[Docker Hub API](https://hub.docker.com/v2/users/anyam/)]

### Domain collisions and observations

ICANN identifies RDAP as the definitive source for gTLD registration information from 28 January 2025. [[ICANN RDAP transition](https://www.icann.org/en/announcements/details/icann-update-launching-rdap-sunsetting-whois-27-01-2025-en)] The point-in-time results were:

| Domain | Authoritative/current RDAP result | Interpretation |
|---|---|---|
| `anyam.dev` | Google Registry `404 Not Found` | No registration object returned; checkout still required |
| `anyam.com` | Verisign `200`, registered object | Already controlled by another registrant |
| `anyam.app` | Google Registry `200`, registered object | Already controlled by another registrant |
| `anyam.ai` | Identity Digital `200`, registered object | Already controlled by another registrant |
| `anyam.io` | No reliable authoritative result obtained through the available RDAP path | Treat as unknown until registrar checkout |

Google Registry positions `.dev` specifically for developer tools and platforms and places the entire TLD on the HSTS preload list. This is a good semantic fit, with the operational consequence that every endpoint must work correctly over HTTPS from its first request. [[Google Registry `.dev`](https://get.dev/)]

### Company-name collision

UK Companies House lists an active `ANYAM LIMITED`, incorporated in 2016, whose stated nature of business is solicitors. This is not an adjacent developer tool, but it means the exact UK legal entity name cannot be assumed available and should not be used in fundraising or incorporation material without a company-name and trademark review. [[Companies House](https://find-and-update.company-information.service.gov.uk/company/09978297)]

Malaysia's SSM, Singapore's ACRA, and other intended incorporation registers were not conclusively searched in this pass because current official public access did not provide a reliable unauthenticated result suitable for citation. Company-secretary checks are an explicit acquisition gate.

### Protocol registries

No `anyam` entry appeared in the official IANA URI Schemes CSV or media-type registry snapshot retrieved on the decision date. [[IANA URI schemes](https://www.iana.org/assignments/uri-schemes/uri-schemes.xhtml)] [[IANA media types](https://www.iana.org/assignments/media-types/media-types.xhtml)]

This is not a reason to register new identifiers. Anyam v1 should use HTTPS URLs, standard Git Smart HTTP, OAuth, MCP, JSON, and versioned schemas. A custom scheme or vendor media type creates ecosystem work without improving the initial developer experience.

## Trademark scope and gates

### Likely core classes

These are search scopes for counsel, not filing instructions:

| Nice class | Why it is relevant | Official scope |
|---|---|---|
| **9** | Downloadable CLI, SDK, credential helper, runner, and other computer software | Class 9 expressly includes recorded/downloadable media and computer software. [[WIPO Nice 2026 Class 9](https://nclpub.wipo.int/enfr/pdf-download.pdf?classNumber=9&dateInForce=20260101&lang=en&tab=&viewMode=flat)] |
| **42** | Hosted SCM, SaaS/PaaS, cloud workspaces, software development, security, verification, hosting, and platform services | Class 42 covers design/development of software, SaaS, PaaS, cloud computing, and computer security services. [[WIPO Nice Class 42](https://nclpub.wipo.int/enfr/?basic_numbers=show&class_number=42&explanatory_notes=show&lang=en&menulang=en&mode=flat&pagination=no&version=20260101)] |

Counsel should search adjacent terms, phonetic equivalents, plural/combined forms, logos, and common-law use—not merely the exact word in classes 9 and 42.

### Conditional adjacent classes

- **38** only if Anyam itself sells telecommunications, transmission, chatroom, or forum services rather than providing those functions incidentally inside software. WIPO describes Class 38 as telecommunications and transmission of data. [[WIPO Nice Class 38](https://nclpub.wipo.int/enfr/?basic_numbers=show&class_number=38&explanatory_notes=show&lang=en&menulang=en&mode=flat&pagination=no&version=20260101)]
- **41** if paid education, training, or publication becomes a material branded service.
- **35** if the product is marketed as business administration, business project management, or a commercial marketplace service rather than software alone.
- **45** is **not** automatically appropriate merely because Anyam has authentication, authorization, policy, or software supply-chain security. WIPO places computer and internet security consultancy and data encryption in Class 42, while Class 45 mainly covers legal and physical-security/personal services. [[WIPO Nice 2026 Class 45](https://nclpub.wipo.int/esen/pdf-download.pdf?classNumber=45&dateInForce=20260101&lang=en&viewMode=flat)]

### Required territorial search

Before launch, instruct qualified counsel to search at minimum:

1. Malaysia—the initial operating/home market.
2. Singapore—likely regional commercial and incorporation relevance.
3. United States—developer-tool market and US federal/common-law rights.
4. European Union and United Kingdom—major software markets with separate rights.
5. Australia—regional English-language software market.
6. Indonesia—because *anyam* is culturally and commercially used there and Du Anyam is an important adjacent brand.
7. WIPO Madrid international marks and any additional countries in the first three-year go-to-market plan.

Official search paths include [MyIPO IP Online](https://www.myipo.gov.my/search-trademark/), [IPOS Digital Hub](https://digitalhub.ipos.gov.sg/FAMN/eservice/IP4SG/MN_Index), [USPTO Trademark Search](https://tmsearch.uspto.gov/), [EUIPO eSearch plus](https://euipo.europa.eu/eSearch/), [UK IPO search](https://www.gov.uk/search-for-trademark), and the [WIPO Global Brand Database](https://www.wipo.int/en/web/global-brand-database). MyIPO also offers paid Preliminary Advice and Search; its current official page lists the service from RM250. [[MyIPO application guidance](https://www.myipo.gov.my/applying-for-a-trademark/)]

### Legal launch gate

Counsel must deliver a written memo covering:

- exact, similar, phonetic, transliterated, and conceptually similar marks;
- registered, pending, and material common-law use;
- word mark and intended logo;
- classes 9 and 42 plus justified adjacent classes;
- the listed launch territories;
- Du Anyam and other weaving-centered regional uses;
- domain/handle conflict and bad-faith acquisition risk;
- recommended filing owner, specifications, priority sequence, and watch strategy;
- a clear **go / go with constraints / no-go** conclusion.

Only that memo constitutes the legal clearance gate. A clean database keyword search does not.

## Acquisition gates

No acquisition is authorized by this document. After legal approval, the owner should execute the following in one controlled window to reduce squatting risk:

1. **Establish the rights owner.** Decide the legal entity that will own domains, trademarks, package publishers, signing keys, and app-store identities.
2. **Acquire `anyam.dev`.** Confirm the actual registrar checkout, price, renewal price, premium status, registry restrictions, and registrant entity; complete registration only through the approved company account.
3. **Harden the domain.** Enable registry/registrar lock as available, auto-renew, DNSSEC, passkey or hardware-key protected administration, multiple audited recovery contacts, and out-of-band recovery.
4. **Acquire defensive domains selectively.** Recheck `anyam.io` and regional typo/confusion risks. Do not buy an indiscriminate portfolio or negotiate for registered domains before counsel approves the strategy.
5. **Claim controlled organization/package identities.** Test and, if appropriate, create a GitHub organization such as `anyam-dev`; an npm scope such as `@anyam-dev`; package names; container registry org; social handles; app-store records; and documentation properties. A prior `404` is not a reservation.
6. **Record ownership.** Put every account in the password manager/asset register with owner, recovery method, renewal date, billing identity, and break-glass procedure.
7. **Publish a signed namespace statement.** Once live, `anyam.dev/.well-known/anyam.json` should list canonical repositories, package publishers, container registries, signing keys, API/MCP origins, and security contact. This protects users from lookalike namespaces.
8. **File only on counsel's advice.** Coordinate domain/package launch with trademark filing and publication timing.
9. **Verify supply-chain identity.** Sign CLI binaries and packages, publish checksums/provenance, and link every official distribution surface from `anyam.dev`.

## Fallback and rebrand strategy

### Trigger conditions

Abandon **Anyam before public launch** if any of these occur:

- counsel returns a no-go or commercially unacceptable geographic/class restriction;
- `anyam.dev` cannot be acquired on acceptable terms and no equally authoritative domain supports a coherent identity;
- the Du Anyam adjacency presents an unacceptable legal, cultural, or reputational risk;
- required signing/package/app-store identities cannot be made unambiguous;
- a newly discovered active developer/infrastructure product creates likely confusion;
- the company cannot secure a defensible word/logo filing strategy in its primary markets.

### Fallback is a process, not an uncleared second name

No replacement name is approved in this document. “Utuh” and earlier brainstormed alternatives have not received the same current screen and must not be described as cleared fallbacks.

If a trigger fires:

1. Freeze external publication and domain/package acquisition.
2. Generate a new shortlist with requirements: ASCII, pronounceable, no category word, viable command, semantically broad across project types, and no dependence on an `.ai` domain.
3. Run every candidate through the same linguistic, cultural, product, company, package, domain, app-store, common-law, and trademark gates.
4. Choose the candidate with the best rights-and-namespace bundle, not merely the nicest `.dev` domain.
5. Obtain domain and legal approval before updating public materials.

### Rebrandability requirements now

Until the brand gate closes, engineering should keep the identity replaceable:

- Centralize human-facing strings, domains, OAuth audiences, package names, event prefixes, telemetry service names, and keychain identifiers.
- Do not persist `anyam` as an unversioned magic string where a neutral internal ID is sufficient.
- Use neutral database identifiers such as UUIDs rather than deriving IDs from brand domains.
- Keep protocol schemas namespace-configurable until `anyam.dev` is controlled.
- Do not publish packages, container images, OAuth clients, mobile apps, browser extensions, or signing certificates under Anyam.
- Maintain a machine-readable identity inventory listing every place the name appears.
- Do not promise compatibility aliases before the first public release. A pre-launch rename should be clean, not permanent dual branding.

If a rebrand occurs **after** an alpha release, provide:

1. signed old-to-new migration notice from both domains;
2. CLI warning and bounded compatibility shim;
3. package deprecation notices pointing only to verified new publishers;
4. credential-helper and keychain migration without exposing secrets;
5. OAuth/MCP audience migration with explicit re-consent;
6. Git remote migration tooling;
7. schema/event alias policy with sunset dates;
8. redirects that preserve security boundaries;
9. updated signatures, provenance identities, SBOMs, and security contact;
10. a published end-of-support date for old names.

## Decision record

### Adopt now

- **Working product name:** Anyam
- **Intended command:** `anyam`
- **Preferred authority domain:** `anyam.dev`, contingent on legal clearance and successful acquisition
- **Current canonical repository:** `github.com/Whyme-Labs/anyam`
- **Current status:** pre-clearance; no public namespace claims

### Reject now

- `forge` as product, command, alias, config directory, environment prefix, or credential helper.
- Any assertion that `@anyam`, `github.com/anyam`, or `docker.io/anyam` belongs to this project.
- A custom `anyam:` URI scheme in v1.
- A proprietary media type without a concrete interoperability need.
- `*.anyam.dev` for untrusted customer runtime content; use a separate registrable domain and security boundary.
- “Available” or “trademark clear” based only on a `404`, empty search, or this report.
- An uncleared fallback name.

### Remaining blockers

| Gate | Owner | Evidence required |
|---|---|---|
| Formal trademark/common-law search | Qualified trademark counsel | Written go/no-go memo covering territories/classes/adjacencies |
| `anyam.dev` acquisition | Authorized company owner | Successful registrar transaction and asset-register entry |
| Company-name clearance | Company secretary/counsel | Written checks for incorporation and trading-name jurisdictions |
| Namespace acquisition | Authorized release owner | Verified control of selected GitHub/npm/container/app-store identities |
| Cultural review | Regional brand reviewer plus counsel | Written assessment of Du Anyam adjacency and visual/narrative guardrails |
| Identity hardening | Security owner | DNSSEC, MFA/passkeys, recovery, locks, signing, and canonical publisher statement |

## Primary-source index

- [DBP PRPM definition of *anyam*](https://prpm.dbp.gov.my/Cari1?d=243192&keyword=anyam)
- [Du Anyam 2025 impact report](https://duanyam.com/wp-content/uploads/2026/02/Du-Anyam-Impact-Report-2025-1.pdf)
- [GitHub exact account API](https://api.github.com/users/anyam)
- [npm official registry search](https://registry.npmjs.org/-/v1/search?text=%40anyam&size=100)
- [Docker Hub exact user API](https://hub.docker.com/v2/users/anyam/)
- [Google Registry RDAP for `anyam.dev`](https://pubapi.registry.google/rdap/domain/anyam.dev)
- [Verisign RDAP for `anyam.com`](https://rdap.verisign.com/com/v1/domain/anyam.com)
- [Google Registry RDAP for `anyam.app`](https://pubapi.registry.google/rdap/domain/anyam.app)
- [Identity Digital RDAP for `anyam.ai`](https://rdap.identitydigital.services/rdap/domain/anyam.ai)
- [ICANN RDAP transition](https://www.icann.org/en/announcements/details/icann-update-launching-rdap-sunsetting-whois-27-01-2025-en)
- [Google Registry `.dev` positioning and HSTS](https://get.dev/)
- [UK Companies House: ANYAM LIMITED](https://find-and-update.company-information.service.gov.uk/company/09978297)
- [IANA URI Scheme registry](https://www.iana.org/assignments/uri-schemes/uri-schemes.xhtml)
- [IANA media-type registry](https://www.iana.org/assignments/media-types/media-types.xhtml)
- [WIPO search-before-filing guidance](https://www.wipo.int/en/web/madrid-system/how_to/search/index)
- [WIPO Global Brand Database FAQ and limitations](https://www.wipo.int/en/web/global-brand-database/faqs_branddb)
- [WIPO Nice Classification, Class 9](https://nclpub.wipo.int/enfr/pdf-download.pdf?classNumber=9&dateInForce=20260101&lang=en&tab=&viewMode=flat)
- [WIPO Nice Classification, Class 42](https://nclpub.wipo.int/enfr/?basic_numbers=show&class_number=42&explanatory_notes=show&lang=en&menulang=en&mode=flat&pagination=no&version=20260101)
- [MyIPO trademark search](https://www.myipo.gov.my/search-trademark/)
- [IPOS Digital Hub](https://digitalhub.ipos.gov.sg/FAMN/eservice/IP4SG/MN_Index)
- [USPTO Trademark Search](https://tmsearch.uspto.gov/)
- [EUIPO eSearch plus](https://euipo.europa.eu/eSearch/)
- [UK IPO trademark search](https://www.gov.uk/search-for-trademark)
