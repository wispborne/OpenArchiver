## ADDED Requirements

### Requirement: Unchanged default response

When a `GET /v1/search` request sets none of `fields`, `crop` or `cropLength`, the response SHALL be identical to the response before this change, including full documents and the fully highlighted `_formatted` copy.

#### Scenario: Existing client

- **WHEN** the frontend or an existing API client calls `/v1/search` with only the parameters that existed before
- **THEN** each hit contains every `EmailDocument` attribute, `_matchesPosition` and `_formatted` covering every attribute

### Requirement: Field selection

`GET /v1/search` SHALL accept an optional comma-separated `fields` parameter naming `EmailDocument` attributes, or `attachments.filename` for attachment names without their extracted text. When given, each hit SHALL contain only those attributes plus `id`. Unknown attribute names SHALL be rejected with `400`.

#### Scenario: Selected fields

- **WHEN** a client calls `/v1/search?keywords=invoice&fields=subject,from,timestamp`
- **THEN** each hit contains only `id`, `subject`, `from` and `timestamp` among the document attributes

#### Scenario: Attachment names only

- **WHEN** a client passes `fields=subject,attachments.filename`
- **THEN** each hit's `attachments` entries contain only `filename`, without extracted text

#### Scenario: Unknown field

- **WHEN** a client passes `fields=subject,password`
- **THEN** the response is `400` with a `message`

### Requirement: Match-centred crops

`GET /v1/search` SHALL accept an optional comma-separated `crop` parameter naming text attributes (`subject`, `body`, `attachments.content`) and an optional positive integer `cropLength` in words. When `crop` is given, `_formatted` SHALL contain those attributes cropped around the best match, with match markers as today. `cropLength` without `crop` SHALL be rejected with `400`. Cropped attributes are returned in `_formatted` even when `fields` does not list them.

#### Scenario: Body snippet

- **WHEN** a client calls `/v1/search?keywords=invoice&fields=subject&crop=body&cropLength=50`
- **THEN** each hit's `_formatted.body` is an excerpt of about 50 words around the match and the hit has no full `body`

#### Scenario: Invalid crop attribute

- **WHEN** a client passes `crop=from`
- **THEN** the response is `400` with a `message`

### Requirement: Highlighting limited to requested attributes

When `fields` or `crop` is given, `_formatted` SHALL contain only the requested and cropped attributes, so whole bodies and attachment text are not duplicated.

#### Scenario: No duplicated body

- **WHEN** a client calls `/v1/search?keywords=invoice&fields=subject&crop=body`
- **THEN** no hit's `_formatted` contains the full body or any full attachment text

### Requirement: Filters, permissions and audit unaffected

The new parameters SHALL NOT change which emails match, the permission filter, pagination or the `SEARCH` audit entry.

#### Scenario: Same hits

- **WHEN** the same query runs with and without `fields`/`crop`
- **THEN** both return the same email ids in the same order and the same `total`

### Requirement: Documented in the API spec

The new parameters SHALL appear in the `/v1/search` `@openapi` block and the committed `docs/api/openapi.json`.

#### Scenario: Spec regenerated

- **WHEN** `pnpm docs:gen-spec` runs
- **THEN** `/v1/search` lists `fields`, `crop` and `cropLength` as optional query parameters
