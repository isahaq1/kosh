# Kosh RFCs

Design documents written before implementation. An RFC is implemented only after it is approved (status Accepted).

| #    | Title | Status |
| ---- | ----- | ------ |
| 0001 | [Module system & manifest](0001-module-system-and-manifest.md) | Accepted |
| 0002 | [Shutro integration & metadata-driven API generation](0002-shutro-integration-and-api-generation.md) | Accepted |
| 0003 | [Permission system](0003-permission-system.md) | Accepted, implemented |
| 0004 | [View definitions & shared search layer](0004-views-and-search.md) | Accepted, implemented |
| 0005 | [Reporting engine](0005-reporting-engine.md) | Accepted, implemented |
| 0006 | [Communication & notification architecture](0006-communication-and-notifications.md) | Accepted; parts 1–8 implemented (chatter, gateway, inbox, email, web push, SMS / WhatsApp, internal chat, inbound email, quiet hours / digests / fallbacks) |
| 0007 | [Frontend architecture & design system](0007-frontend-architecture.md) | Accepted, implemented |
| 0008 | [Default business apps & App manager](0008-business-apps-and-app-manager.md) | Accepted; steps 1–7 implemented (`kosh apps`, app host, Settings → Apps, Contacts / Products / Sales / Purchase / Accounting / Projects and the bridges, the default set, the apps' E2E catalogue) |
| 0009 | [Accounting](0009-accounting.md) | Accepted; steps 1–4 implemented (the ledger, documents and bridges, payments and reconciliation, reports and closing) |
| 0010 | [A modern, fast, friendly back-office](0010-modern-ux.md) | Phase A accepted (within RFC 0007); Phase B implemented; C: its three subsystems get RFCs of their own, 0011 first |
| 0011 | [Automation builder](0011-automation-builder.md) | Accepted, implemented (the engine, the API, the editor, webhooks, date and schedule triggers, rules shipped by modules, rules on any field) |
| 0012 | [Kosh Studio](0012-studio.md) | Accepted, implemented (the spec and generator, `kosh apps upgrade`, the API, Studio mode, approvals and rules, git proposals) |
| 0013 | [AI assistant](0013-ai-assistant.md) | Accepted, implemented (natural-language search, summaries, draft replies, forms from documents) |
| 0014 | [Data import](0014-data-import.md) | Accepted, implemented (the parsers and the import, keys, lines, skip errors, undo, background runs, saved mappings, templates, the screen) |
| 0015 | [Customer and vendor portal](0015-customer-portal.md) | Accepted, implemented (portal users and invitations, the internal-only guard, documents declared in manifests, the portal API with signatures, Sales / Accounting / Purchase / Projects in the portal, announcements, the portal app) |
| 0016 | [Country localizations (Bangladesh first)](0016-localizations.md) | Accepted; steps 1–4 implemented (several taxes per line, bank accounts and payment details, fiscal year start, amounts in words, lakh grouping; withholding at payment with certificates; the `localization` declaration and `l10n_bd`; the Mushak documents, registers and return; step 5 parts 1–3: tax components by place of supply, reverse charge, debit notes, `l10n_in`, GSTR-1 / 3B, e-invoicing and e-way bills with the fake provider) |
| 0017 | [Integrations platform](0017-integrations.md) | Accepted: API keys and service accounts, OAuth 2.0 apps, outbound and inbound webhooks, online payments |
| 0018 | [Workspace back-office](0018-workspace-ui.md) | Accepted, implemented |
| 0019 | [Settings](0019-settings.md) | Accepted, implemented |
| 0020 | [App settings](0020-app-settings.md) | Accepted; step 1 implemented (the declaration, the API, the per-app page; Sales, Purchase, Accounting) |
| 0021 | [Business apps, part 2](0021-business-apps-2.md) | Accepted; Focus, Agenda, Pipeline, Workforce and Hiring step 1 implemented; Stockroom and Production complete |
