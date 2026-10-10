## ADDED Requirements

### Requirement: Parsed email content endpoint

The API SHALL expose `GET /v1/archived-emails/{id}/content`, which returns the archived email parsed on the server as JSON with these fields: `id`, `subject`, `from`, `to`, `cc`, `bcc`, `sentAt`, `messageId`, `inReplyTo`, `references`, `userEmail`, `ingestionSource` (`id` and `name` only), `text`, `attachments`, `thread` and `truncated`. The response MUST NOT contain the raw message bytes.

#### Scenario: Plain-text email

- **WHEN** an authorized client requests `/content` for an email that has a `text/plain` part
- **THEN** the response is `200` and `text` holds that part's decoded text

#### Scenario: HTML-only email

- **WHEN** an authorized client requests `/content` for an email that has only a `text/html` part
- **THEN** `text` holds a plain-text rendering of the HTML, without tags, scripts or styles

#### Scenario: Thread siblings

- **WHEN** the email belongs to a thread whose messages span several sources of one merge group
- **THEN** `thread` lists every message of the thread across the merge group, each with `id`, `subject`, `sentAt`, `senderName` and `senderEmail`, ordered by `sentAt`, exactly as `GET /v1/archived-emails/{id}` does

### Requirement: Same permissions and auditing as reading an email

The `/content` endpoint SHALL require the `read` action on `archive`, SHALL evaluate the caller's permission against the email row (so IAM conditions such as `userEmail` apply), and SHALL write a `READ` audit entry for the email on success. It MUST share this logic with `GET /v1/archived-emails/{id}` rather than duplicate it.

#### Scenario: Caller cannot read the email

- **WHEN** a caller whose role cannot read the email's mailbox requests `/content`
- **THEN** the response is `404` with the same body `GET /v1/archived-emails/{id}` returns, and no audit entry is written

#### Scenario: Unknown email

- **WHEN** a caller requests `/content` for an id that does not exist
- **THEN** the response is `404`

#### Scenario: Audit entry

- **WHEN** an authorized caller reads an email through `/content`
- **THEN** a `READ` audit entry with target type `ArchivedEmail` and the email's id is recorded

#### Scenario: API key authentication

- **WHEN** the request carries a valid `X-API-KEY` instead of a session token
- **THEN** the endpoint behaves as for the key's user

### Requirement: Optional HTML

The `/content` endpoint SHALL include an `html` field only when the request sets `includeHtml=true`.

#### Scenario: HTML not requested

- **WHEN** the request omits `includeHtml`
- **THEN** the response has no `html` field

#### Scenario: HTML requested

- **WHEN** the request sets `includeHtml=true` and the email has an HTML part
- **THEN** `html` holds that part

### Requirement: Attachments with optional extracted text

`attachments` SHALL list each attachment of the email with `id`, `filename`, `mimeType` and `sizeBytes`. When the request sets `includeAttachmentText=true`, each attachment SHALL also carry `text`: the text extracted at indexing time, read from the email's search document, or `null` when the email is not indexed or no text was extracted for that attachment.

#### Scenario: Text not requested

- **WHEN** the request omits `includeAttachmentText`
- **THEN** no attachment carries a `text` field

#### Scenario: Indexed email

- **WHEN** the request sets `includeAttachmentText=true` and the email is indexed with extracted attachment text
- **THEN** each attachment's `text` holds its extracted text

#### Scenario: Unindexed email

- **WHEN** the request sets `includeAttachmentText=true` and the email has no search document
- **THEN** the response is `200` and every attachment's `text` is `null`

### Requirement: Body truncation

The endpoint SHALL accept an optional positive integer `maxChars`. When given and `text` is longer, `text` SHALL be cut to `maxChars` characters and `truncated` SHALL be `true`; otherwise `truncated` SHALL be `false`. Without `maxChars` the full text is returned.

#### Scenario: Long body truncated

- **WHEN** the request sets `maxChars=100` and the email's text is 500 characters
- **THEN** `text` has 100 characters and `truncated` is `true`

#### Scenario: No limit

- **WHEN** the request omits `maxChars`
- **THEN** `text` is complete and `truncated` is `false`

#### Scenario: Invalid limit

- **WHEN** `maxChars` is not a positive integer
- **THEN** the response is `400` with a `message`

### Requirement: Documented in the API spec

The endpoint and its parameters SHALL be described by an `@openapi` block and appear in the committed `docs/api/openapi.json`.

#### Scenario: Spec regenerated

- **WHEN** `pnpm docs:gen-spec` runs
- **THEN** `/v1/archived-emails/{id}/content` is present in the generated spec without YAML errors
